# suite:
#   lanes: db
#   why: 0251 -- that with security.require_mfa_for_managers on, every write policy and function
#     that calls require_mfa() refuses an Administrator or a Shopfloor Manager at aal1 and admits
#     them at aal2, federated or with the switch off; that an Operator and a machine identity are
#     never asked; that every has_role() site naming a covered role asks or is in
#     supabase/mfa-exemptions.json; and that turning it on, or granting a covered role while it is
#     on, ends the app sessions Grafana's excepted, with one SESSIONS_ENDED row per person.

"""
With MFA required, a manager's or an Administrator's change to the platform needs a session that
gave its code (0251).

    python supabase/migrations/test_with_mfa_required_a_write_needs_a_session_that_gave_its_code.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here, with `request.jwt.claims` at aal1 and aal2, and with a federated `amr`:

  * the Settings row: off by default, every role reads it, an Administrator turns it on from any
    session and off only from one that gave its code;
  * mfa_satisfied() for every role, a machine identity and no role, the switch on and off;
  * every write policy that calls require_mfa(), as pg_policies holds it: refused for a covered
    person at aal1 with the switch on (42501, detail mfa_required), admitted otherwise, and never
    raised for an Operator or a machine identity, whom has_role() refuses on its own;
  * real writes and every function that calls require_mfa(), the same way, and a machine identity
    with schema:manage and proposal:create unaffected where it writes;
  * a suppression window scheduled (0240) and the webhook's address set (0248), the same way;
  * the exemption list: every has_role() site naming a covered role in the database calls
    require_mfa() or is in supabase/mfa-exemptions.json, and a planted one is caught;
  * the app sessions that end, with their refresh tokens, when the switch turns on and when a
    covered role is granted while it is on, and one SESSIONS_ENDED row per person.

EVERY TEST ROLLS BACK: the switch, the people and the Audit Trail rows go with the transaction.
"""
import json
import os
import re
import unittest
import uuid
from pathlib import Path

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

EXEMPTIONS = json.loads((Path(__file__).resolve().parents[1] / "mfa-exemptions.json").read_text(encoding="utf-8"))

SETTING = "security.require_mfa_for_managers"
REFUSAL = "MFA is required for this. Add an authenticator on Profile › MFA, then try again."

ADMIN_ID = "0251a000-0000-4000-8000-0000000000a1"
ADMIN_2_ID = "0251a000-0000-4000-8000-0000000000a2"
MANAGER_ID = "0251a000-0000-4000-8000-0000000000b1"
OPERATOR_ID = "0251a000-0000-4000-8000-0000000000c1"
AUDITOR_ID = "0251a000-0000-4000-8000-0000000000d1"
NO_ROLE_ID = "0251a000-0000-4000-8000-0000000000e1"
MACHINE_ID = "0251a000-0000-4000-8000-0000000000f1"
PEOPLE = {ADMIN_ID: "Administrator", ADMIN_2_ID: "Administrator", MANAGER_ID: "Shopfloor_Manager",
          OPERATOR_ID: "Operator", AUDITOR_ID: "Auditor", NO_ROLE_ID: None}

GRAFANA = "c0ffee00-0000-4000-8000-000000000001"
NODE_RED = "c0ffee00-0000-4000-8000-000000000002"
STUDIO = "c0ffee00-0000-4000-8000-000000000003"
OUTSIDE = "0251a000-0000-4000-8000-0000000000aa"   # an app #1036 would register

COVERED = re.compile(r"has_role\(ARRAY\[[^\]]*'(?:Administrator|Shopfloor_Manager)'")
FEDERATED = [{"method": "oauth", "timestamp": 1}]
SAML = [{"method": "sso/saml", "timestamp": 1}]
APP_CODE = [{"method": "oauth_provider/authorization_code", "timestamp": 1}]


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class MfaBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.require_mfa()'), to_regclass('auth.oauth_authorizations');")
        if None in self.cur.fetchone():
            self.skipTest("0251 or the GoTrue fixture's auth.oauth_authorizations is not in this database")
        self.cur.execute("SELECT name, id FROM public.roles;")
        self.roles = dict(self.cur.fetchall())
        for user_id, role in PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@mfa.test"),
            )
            if role:
                self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s);",
                                 (user_id, self.roles[role]))
        # A machine identity: no email, no password, no identity provider, and permissions of its own.
        self.cur.execute("INSERT INTO auth.users (id, created_at) VALUES (%s, now()) ON CONFLICT (id) DO NOTHING;",
                         (MACHINE_ID,))
        self.cur.execute(
            "INSERT INTO public.principal_permissions (principal_id, permission_id)"
            " SELECT %s, id FROM public.permissions WHERE name IN ('schema:manage', 'proposal:create')"
            " ON CONFLICT DO NOTHING;",
            (MACHINE_ID,),
        )
        for app_id, name in ((GRAFANA, "Aber Grafana"), (NODE_RED, "Aber Node-RED"),
                             (STUDIO, "Aber Supabase Studio"), (OUTSIDE, "Shift Reports")):
            self.cur.execute(
                "INSERT INTO auth.oauth_clients (id, registration_type, client_name) VALUES (%s, 'manual', %s)"
                " ON CONFLICT (id) DO UPDATE SET client_name = EXCLUDED.client_name;",
                (app_id, name),
            )
        self.switch(False)

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def switch(self, on):
        """Set the switch as the owner would, with no caller."""
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("UPDATE public.system_settings SET value = %s::jsonb WHERE key = %s;",
                         ("true" if on else "false", SETTING))

    def claims(self, user_id, aal="aal1", amr=None):
        """The caller's session, as PostgREST hands it to the database, as `authenticated`."""
        self.cur.execute("RESET ROLE;")
        claims = {"sub": user_id, "role": "authenticated", "aal": aal}
        if amr is not None:
            claims["amr"] = amr
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
        self.cur.execute("SET LOCAL ROLE authenticated;")

    def attempt(self, statement, args=None):
        """(None, rows) when the statement ran, or (the error, None), inside a savepoint."""
        self.cur.execute("SAVEPOINT attempt;")
        try:
            self.cur.execute(statement, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error as err:
            self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")
            return err, None
        self.cur.execute("RELEASE SAVEPOINT attempt;")
        return None, rows

    def assert_mfa_refusal(self, err, what):
        self.assertIsInstance(err, psycopg2.errors.InsufficientPrivilege, f"{what}: {err}")
        self.assertEqual(err.diag.message_primary, REFUSAL, what)
        self.assertEqual(err.diag.message_detail, "mfa_required", what)

    def is_mfa_refusal(self, err):
        return err is not None and getattr(err.diag, "message_detail", None) == "mfa_required"

    def satisfied(self):
        self.cur.execute("SELECT public.mfa_satisfied();")
        return self.cur.fetchone()[0]


class TheSettingsRow(MfaBase):
    def test_it_is_a_boolean_every_role_reads_and_off_by_default(self):
        self.cur.execute("SELECT value_type, category, sensitive, read_only FROM public.system_settings WHERE key = %s;",
                         (SETTING,))
        self.assertEqual(self.cur.fetchone(), ("boolean", "Security", False, False))
        # The fixture turned it off; a fresh install seeds it off (0002).
        self.claims(OPERATOR_ID)
        self.cur.execute("SELECT value FROM public.system_settings WHERE key = %s;", (SETTING,))
        self.assertEqual(self.cur.fetchone(), (False,))

    def test_an_administrator_turns_it_on_from_any_session_and_off_only_with_a_code(self):
        self.claims(ADMIN_ID, "aal1")
        err, rows = self.attempt("UPDATE public.system_settings SET value = 'true' WHERE key = %s RETURNING key;", (SETTING,))
        self.assertIsNone(err, err)
        self.assertEqual(rows, [(SETTING,)], "an aal1 Administrator may turn it on")
        err, _ = self.attempt("UPDATE public.system_settings SET value = 'false' WHERE key = %s;", (SETTING,))
        self.assert_mfa_refusal(err, "an aal1 Administrator turning it off")
        self.claims(ADMIN_ID, "aal2")
        err, rows = self.attempt("UPDATE public.system_settings SET value = 'false' WHERE key = %s RETURNING key;", (SETTING,))
        self.assertIsNone(err, err)
        self.assertEqual(rows, [(SETTING,)])

    def test_a_manager_may_not_change_it_whatever_the_session(self):
        for aal in ("aal1", "aal2"):
            self.claims(MANAGER_ID, aal)
            err, rows = self.attempt("UPDATE public.system_settings SET value = 'true' WHERE key = %s RETURNING key;", (SETTING,))
            self.assertIsNone(err, f"{aal}: {err}")
            self.assertEqual(rows, [], f"a Shopfloor Manager at {aal} changed the switch")


class ThePredicate(MfaBase):
    def test_it_answers_for_every_role_session_and_switch(self):
        # (caller, aal, amr, with the switch on)
        cases = [
            (ADMIN_ID, "aal1", None, False), (ADMIN_ID, "aal2", None, True), (ADMIN_ID, "aal1", FEDERATED, True),
            (ADMIN_ID, "aal1", SAML, True), (ADMIN_ID, "aal1", APP_CODE, False),
            (MANAGER_ID, "aal1", None, False), (MANAGER_ID, "aal2", None, True),
            (OPERATOR_ID, "aal1", None, True), (AUDITOR_ID, "aal1", None, True), (NO_ROLE_ID, "aal1", None, True),
            (MACHINE_ID, "aal1", None, True),
        ]
        for on in (False, True):
            self.switch(on)
            for user_id, aal, amr, expected_on in cases:
                self.claims(user_id, aal, amr)
                with self.subTest(on=on, user=user_id, aal=aal, amr=amr):
                    self.assertEqual(self.satisfied(), expected_on if on else True)

    def test_a_token_with_no_claims_is_no_covered_person(self):
        self.switch(True)
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true); SET LOCAL ROLE authenticated;")
        self.assertTrue(self.satisfied())


class EveryCoveredPolicy(MfaBase):
    def policies(self):
        self.cur.execute(
            "SELECT schemaname || '.' || tablename || ' ' || policyname, cmd, qual, with_check FROM pg_policies"
            " WHERE schemaname = 'public' AND cmd <> 'SELECT'"
            "   AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%require_mfa()%' ORDER BY 1;"
        )
        rows = self.cur.fetchall()
        self.assertTrue(rows, "no write policy calls require_mfa()")
        return rows

    def evaluate(self, expression):
        return self.attempt(f"SELECT ({expression});")

    def test_each_refuses_a_covered_person_at_aal1_while_the_switch_is_on(self):
        rows = self.policies()
        self.assertIn("public.areas areas_update_privileged", [r[0] for r in rows])
        self.assertIn("public.system_settings system_settings_update_admin", [r[0] for r in rows])
        self.switch(True)
        for name, _cmd, qual, check in rows:
            for expression in filter(None, (qual, check)):
                # Each covered role the policy admits; one it does not is refused by has_role() first.
                for user_id in [ADMIN_ID] + ([MANAGER_ID] if "Shopfloor_Manager" in expression else []):
                    self.claims(user_id, "aal1")
                    err, _ = self.evaluate(expression)
                    with self.subTest(policy=name, user=user_id):
                        self.assert_mfa_refusal(err, name)

    def test_each_admits_them_with_a_code_or_with_the_switch_off(self):
        rows = self.policies()
        for on, aal, amr in ((True, "aal2", None), (True, "aal1", FEDERATED), (False, "aal1", None)):
            self.switch(on)
            self.claims(ADMIN_ID, aal, amr)
            for name, _cmd, qual, check in rows:
                for expression in filter(None, (qual, check)):
                    err, result = self.evaluate(expression)
                    with self.subTest(policy=name, on=on, aal=aal):
                        self.assertIsNone(err, err)
                        self.assertEqual(result, [(True,)], "an Administrator is admitted")

    def test_an_operator_and_a_machine_identity_are_refused_by_role_alone(self):
        rows = self.policies()
        self.switch(True)
        for user_id in (OPERATOR_ID, AUDITOR_ID, MACHINE_ID):
            self.claims(user_id, "aal1")
            for name, _cmd, qual, check in rows:
                for expression in filter(None, (qual, check)):
                    err, result = self.evaluate(expression)
                    with self.subTest(policy=name, user=user_id):
                        self.assertIsNone(err, f"require_mfa() raised for a caller has_role() refuses: {err}")
                        self.assertEqual(result, [(False,)])


class RealWrites(MfaBase):
    def test_an_insert_an_update_and_a_delete(self):
        self.cur.execute("INSERT INTO public.areas (name) VALUES ('0251 hall') RETURNING id;")
        area = self.cur.fetchone()[0]
        statements = [
            ("INSERT INTO public.areas (name) VALUES ('0251 annex') RETURNING id;", None),
            ("UPDATE public.areas SET name = '0251 hall, renamed' WHERE id = %s RETURNING id;", (area,)),
            ("DELETE FROM public.areas WHERE id = %s RETURNING id;", (area,)),
        ]
        self.switch(True)
        for statement, args in statements:
            self.claims(MANAGER_ID, "aal1")
            err, _ = self.attempt(statement, args)
            self.assert_mfa_refusal(err, statement)
            self.claims(MANAGER_ID, "aal2")
            err, rows = self.attempt(statement, args)
            self.assertIsNone(err, f"{statement} at aal2: {err}")
            self.assertEqual(len(rows), 1, statement)
        # The switch off, aal1 is enough again; and an Operator's refusal is the policy's, not MFA's.
        self.switch(False)
        self.claims(MANAGER_ID, "aal1")
        err, rows = self.attempt("INSERT INTO public.areas (name) VALUES ('0251 shed') RETURNING id;")
        self.assertIsNone(err, err)
        self.switch(True)
        self.claims(OPERATOR_ID, "aal1")
        err, _ = self.attempt("INSERT INTO public.areas (name) VALUES ('0251 yard');")
        self.assertIsInstance(err, psycopg2.errors.InsufficientPrivilege)
        self.assertFalse(self.is_mfa_refusal(err), "an Operator was refused for MFA, not for their role")

    def test_an_update_that_matches_nothing_is_no_refusal(self):
        self.switch(True)
        self.claims(MANAGER_ID, "aal1")
        err, rows = self.attempt("UPDATE public.areas SET name = name WHERE id = %s RETURNING id;", (str(uuid.uuid4()),))
        self.assertIsNone(err, err)
        self.assertEqual(rows, [])

    def gated_functions(self):
        self.cur.execute(
            "SELECT p.oid::regprocedure::text, p.pronargs FROM pg_proc p"
            " JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'"
            " WHERE p.prosrc LIKE '%require_mfa()%' AND p.proname NOT IN ('require_mfa', 'mfa_satisfied')"
            " AND has_function_privilege('authenticated', p.oid, 'EXECUTE') ORDER BY 1;"
        )
        return self.cur.fetchall()

    def call(self, signature, nargs):
        name = signature.split("(")[0]
        args = ", ".join(f"NULL::{t.strip()}" for t in signature[len(name) + 1:-1].split(",")) if nargs else ""
        return self.attempt(f"SELECT {name}({args});")

    def test_every_function_that_calls_it_refuses_a_covered_person_at_aal1(self):
        functions = self.gated_functions()
        names = {f.split("(")[0].removeprefix("public.") for f, _ in functions}
        for expected in ("approve_proposal", "create_machine_principal", "publish_schema_version", "remove_app",
                         "set_device_schemas", "may_manage_captures"):
            self.assertIn(expected, names, f"{expected}() is not gated")
        self.switch(True)
        for signature, nargs in functions:
            self.claims(ADMIN_ID, "aal1")
            err, _ = self.call(signature, nargs)
            with self.subTest(function=signature):
                self.assert_mfa_refusal(err, signature)

    def test_a_code_passes_every_one_of_them(self):
        self.switch(True)
        for signature, nargs in self.gated_functions():
            self.claims(ADMIN_ID, "aal2")
            err, _ = self.call(signature, nargs)
            with self.subTest(function=signature):
                self.assertFalse(self.is_mfa_refusal(err), f"{signature} refused an aal2 session for MFA")

    def test_a_person_s_role_change_and_their_own_name(self):
        self.switch(True)
        self.claims(ADMIN_ID, "aal1")
        err, _ = self.attempt("SELECT public.set_person_role(%s, 'Auditor');", (OPERATOR_ID,))
        self.assert_mfa_refusal(err, "Change Role at aal1")
        # A person's own display name is theirs at any assurance.
        err, _ = self.attempt("SELECT public.set_display_name(%s, 'Me, Myself');", (ADMIN_ID,))
        self.assertIsNone(err, err)
        self.claims(ADMIN_ID, "aal2")
        err, _ = self.attempt("SELECT public.set_person_role(%s, 'Auditor');", (OPERATOR_ID,))
        self.assertIsNone(err, err)

    def test_a_machine_identity_writes_where_it_always_has(self):
        self.switch(True)
        self.claims(MACHINE_ID, "aal1")
        for signature in ("public.fork_schema", "public.publish_schema_version", "public.discard_schema_draft"):
            self.cur.execute("SELECT oid::regprocedure::text, pronargs FROM pg_proc WHERE oid::regproc::text = %s;",
                             (signature,))
            for found, nargs in self.cur.fetchall():
                err, _ = self.call(found, nargs)
                with self.subTest(function=found):
                    self.assertFalse(self.is_mfa_refusal(err), f"a machine identity was asked for MFA by {found}")
        self.assertTrue(self.satisfied())
        self.cur.execute("SELECT public.require_mfa();")
        self.assertEqual(self.cur.fetchone(), (True,))


class TheExemptionList(MfaBase):
    UNGUARDED = """
        SELECT 'policy ' || schemaname || '.' || tablename || ' ' || policyname FROM pg_policies
         WHERE schemaname = 'public' AND cmd <> 'SELECT'
           AND regexp_count(coalesce(qual, '') || coalesce(with_check, ''),
                            'has_role\\(ARRAY\\[[^]]*''(Administrator|Shopfloor_Manager)''')
             > regexp_count(coalesce(qual, '') || coalesce(with_check, ''), 'require_mfa\\(\\)')
        UNION ALL
        SELECT 'function ' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.prosrc ~ 'has_role\\(ARRAY\\[[^]]*''(Administrator|Shopfloor_Manager)'''
           AND p.prosrc NOT LIKE '%%require_mfa()%%'
        ORDER BY 1;
    """

    def unguarded(self):
        self.cur.execute(self.UNGUARDED)
        exempt = {f"function {n}" for n in EXEMPTIONS["functions"]} | {f"policy {n}" for n in EXEMPTIONS["policies"]}
        return [row[0] for row in self.cur.fetchall() if row[0] not in exempt]

    def test_every_site_asks_or_is_exempt_with_a_reason(self):
        self.assertEqual(self.unguarded(), [])
        for name, reason in EXEMPTIONS["functions"].items():
            self.assertTrue(reason.strip(), f"{name} is exempt with no reason")
            self.cur.execute("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
                             " WHERE n.nspname = 'public' AND p.proname = %s;", (name,))
            self.assertGreater(self.cur.fetchone()[0], 0, f"supabase/mfa-exemptions.json names {name}, which does not exist")

    def test_a_planted_policy_and_function_are_caught(self):
        self.cur.execute(
            "CREATE POLICY planted_insert ON public.areas FOR INSERT TO authenticated"
            " WITH CHECK (public.has_role(ARRAY['Administrator']));"
        )
        self.cur.execute(
            "CREATE FUNCTION public.planted_write() RETURNS void LANGUAGE plpgsql AS $$"
            " BEGIN IF NOT public.has_role(ARRAY['Shopfloor_Manager']) THEN RAISE EXCEPTION 'no'; END IF; END $$;"
        )
        self.assertEqual(self.unguarded(), ["function planted_write", "policy public.areas planted_insert"])


class AWindowAndTheWebhookAskToo(MfaBase):
    """A suppression window's writers (0240) and the webhook's Administrator functions (0248) ask
    after their role check, as every function 0251 gates does."""

    WINDOW_DEVICE_ID = "0240a251-0000-4000-8000-0000000000d1"
    HOOK_URL = "https://hooks.example.net/receiver/path-0248"
    SCHEDULE = ("SELECT id FROM public.schedule_alert_suppression_window('device', %s, NULL,"
                " now() + interval '1 hour', 'Belt change');")

    def setUp(self):
        super().setUp()
        self.cur.execute("SELECT to_regprocedure('public.schedule_alert_suppression_window(text, uuid,"
                         " timestamp with time zone, timestamp with time zone, text)'),"
                         " to_regprocedure('public.set_notification_webhook_url(text)');")
        if None in self.cur.fetchone():
            self.skipTest("0240 or 0248 is not in this database")
        self.cur.execute("INSERT INTO public.devices (id, name) VALUES (%s, 'Test_0251_Press');", (self.WINDOW_DEVICE_ID,))

    def test_a_window_is_scheduled_only_from_a_session_that_gave_its_code(self):
        self.switch(True)
        self.claims(MANAGER_ID, "aal1")
        err, _ = self.attempt(self.SCHEDULE, (self.WINDOW_DEVICE_ID,))
        self.assert_mfa_refusal(err, "scheduling a window at aal1")
        self.claims(MANAGER_ID, "aal2")
        err, rows = self.attempt(self.SCHEDULE, (self.WINDOW_DEVICE_ID,))
        self.assertIsNone(err, err)
        self.assertEqual(len(rows), 1)
        self.claims(OPERATOR_ID, "aal2")
        err, _ = self.attempt(self.SCHEDULE, (self.WINDOW_DEVICE_ID,))
        self.assertIsInstance(err, psycopg2.errors.InsufficientPrivilege)
        self.assertFalse(self.is_mfa_refusal(err), "an Operator was refused for MFA, not for their role")
        self.switch(False)
        self.claims(MANAGER_ID, "aal1")
        err, rows = self.attempt(self.SCHEDULE, (self.WINDOW_DEVICE_ID,))
        self.assertIsNone(err, err)
        self.assertEqual(len(rows), 1, "with the switch off, aal1 is enough")

    def test_the_webhook_s_address_is_set_only_from_a_session_that_gave_its_code(self):
        call = "SELECT public.set_notification_webhook_url(%s);"
        self.switch(True)
        self.claims(ADMIN_ID, "aal1")
        err, _ = self.attempt(call, (self.HOOK_URL,))
        self.assert_mfa_refusal(err, "setting the webhook's address at aal1")
        self.claims(ADMIN_ID, "aal2")
        err, _ = self.attempt(call, (self.HOOK_URL,))
        self.assertIsNone(err, err)
        self.switch(False)
        self.claims(ADMIN_ID, "aal1")
        err, _ = self.attempt(call, (self.HOOK_URL,))
        self.assertIsNone(err, err)

    def test_a_test_email_is_queued_only_from_a_session_that_gave_its_code(self):
        self.cur.execute("SELECT to_regprocedure('public.queue_test_email_notification()');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0263 is not in this database")
        call = "SELECT public.queue_test_email_notification();"
        self.switch(True)
        self.claims(ADMIN_ID, "aal1")
        err, _ = self.attempt(call)
        self.assert_mfa_refusal(err, "queueing a test email at aal1")
        self.claims(ADMIN_ID, "aal2")
        err, rows = self.attempt(call)
        self.assertIsNone(err, err)
        self.assertEqual(len(rows), 1)
        self.claims(MANAGER_ID, "aal2")
        err, _ = self.attempt(call)
        self.assertIsInstance(err, psycopg2.errors.InsufficientPrivilege)
        self.assertFalse(self.is_mfa_refusal(err), "a manager was refused for MFA, not for their role")
        self.switch(False)
        self.claims(ADMIN_ID, "aal1")
        err, _ = self.attempt(call)
        self.assertIsNone(err, err)


class DoorSessions(MfaBase):
    def setUp(self):
        super().setUp()
        self.sessions = {}
        # (person, app) -> a session with two refresh tokens, as GoTrue starts one.
        for user_id in (ADMIN_ID, MANAGER_ID, OPERATOR_ID):
            for app in (None, GRAFANA, NODE_RED, STUDIO, OUTSIDE):
                self.sessions[(user_id, app)] = self.start_session(user_id, app)

    def start_session(self, user_id, app):
        session_id = str(uuid.uuid4())
        self.cur.execute("RESET ROLE;")
        self.cur.execute("INSERT INTO auth.sessions (id, user_id, oauth_client_id) VALUES (%s, %s, %s);",
                         (session_id, user_id, app))
        for n in range(2):
            self.cur.execute(
                "INSERT INTO auth.refresh_tokens (token, user_id, revoked, created_at, updated_at, session_id)"
                " VALUES (%s, %s, false, now(), now(), %s);",
                (f"0251-{session_id}-{n}", user_id, session_id),
            )
        return session_id

    def alive(self, session_id):
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT (SELECT count(*) FROM auth.sessions WHERE id = %s),"
                         " (SELECT count(*) FROM auth.refresh_tokens WHERE session_id = %s);", (session_id, session_id))
        sessions, tokens = self.cur.fetchone()
        self.assertEqual(tokens, 2 * sessions, "a session's refresh tokens outlived it")
        return sessions == 1

    def rows(self, user_id):
        self.cur.execute("RESET ROLE;")
        self.cur.execute(
            "SELECT changed_by::text, new_data FROM public.audit_trail"
            " WHERE entity_type = 'user_roles' AND entity_id = %s AND action = 'SESSIONS_ENDED' ORDER BY recorded_at;",
            (user_id,),
        )
        return self.cur.fetchall()

    def test_turning_it_on_ends_every_covered_person_s_app_sessions_but_grafana_s(self):
        self.claims(ADMIN_ID, "aal1")
        self.cur.execute("UPDATE public.system_settings SET value = 'true' WHERE key = %s;", (SETTING,))
        for (user_id, app), session_id in self.sessions.items():
            ends = PEOPLE[user_id] in ("Administrator", "Shopfloor_Manager") and app not in (None, GRAFANA)
            with self.subTest(user=user_id, app=app):
                self.assertEqual(self.alive(session_id), not ends)
        for user_id in (ADMIN_ID, MANAGER_ID):
            rows = self.rows(user_id)
            self.assertEqual(len(rows), 1, "one row per person, not per session")
            changed_by, data = rows[0]
            self.assertEqual(changed_by, ADMIN_ID, "the Administrator who turned it on")
            self.assertEqual(data["sessions_ended"], 3)
            self.assertEqual(sorted(data["apps"]), ["Aber Node-RED", "Aber Supabase Studio", "Shift Reports"])
            self.assertEqual(data["reason"], "MFA was turned on in Settings")
            self.assertEqual(data["email"], f"{user_id}@mfa.test")
        self.assertEqual(self.rows(OPERATOR_ID), [])

        # Saving the same value again changes nothing and ends nothing.
        late = self.start_session(MANAGER_ID, NODE_RED)
        self.claims(ADMIN_ID, "aal2")
        self.cur.execute("UPDATE public.system_settings SET value = 'true' WHERE key = %s;", (SETTING,))
        self.assertTrue(self.alive(late))

    def test_a_covered_role_granted_while_it_is_on_ends_that_person_s(self):
        self.switch(True)
        operator_node_red = self.start_session(OPERATOR_ID, NODE_RED)
        operator_grafana = self.sessions[(OPERATOR_ID, GRAFANA)]
        manager_node_red = self.start_session(MANAGER_ID, NODE_RED)
        self.claims(ADMIN_ID, "aal2")
        self.cur.execute("RESET ROLE;")
        self.cur.execute("UPDATE public.user_roles SET role_id = %s WHERE user_id = %s;",
                         (self.roles["Shopfloor_Manager"], OPERATOR_ID))
        self.assertFalse(self.alive(operator_node_red), "an Operator made a Shopfloor Manager keeps a door session")
        self.assertTrue(self.alive(operator_grafana))
        self.assertEqual([d["reason"] for _, d in self.rows(OPERATOR_ID)], ["Given a role that needs MFA"])
        # Within the covered roles, nothing changes: their sessions were already won under the switch.
        self.cur.execute("UPDATE public.user_roles SET role_id = %s WHERE user_id = %s;",
                         (self.roles["Administrator"], MANAGER_ID))
        self.assertTrue(self.alive(manager_node_red))
        # A first role, given to someone who had none.
        none_node_red = self.start_session(NO_ROLE_ID, NODE_RED)
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s);",
                         (NO_ROLE_ID, self.roles["Administrator"]))
        self.assertFalse(self.alive(none_node_red))

    def test_with_it_off_a_grant_ends_nothing(self):
        node_red = self.sessions[(OPERATOR_ID, NODE_RED)]
        self.cur.execute("RESET ROLE;")
        self.cur.execute("UPDATE public.user_roles SET role_id = %s WHERE user_id = %s;",
                         (self.roles["Administrator"], OPERATOR_ID))
        self.assertTrue(self.alive(node_red))
        self.assertEqual(self.rows(OPERATOR_ID), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
