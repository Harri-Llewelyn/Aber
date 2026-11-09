"""
An Administrator registers an app that signs people in with Aber (0260).

    python supabase/migrations/test_an_administrator_registers_an_app_that_signs_people_in.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: app_redirect_problem() answers every case in
test-harness/fixtures/app-redirect-addresses.json, the file the dialog's own rule is held to;
site_domain() reads the domain of the API's address in the Directory; register_app() adds one row
of auth.oauth_clients as 0002 adds the stack's four (manual, the code and refresh grants, the
secret kept as the SHA-256 hash GoTrue compares) and returns the secret once, for a confidential
app and for no public one; only an Administrator may call it, and with Settings requiring a second
factor only from a session that gave its code; every refusal of a bad name, type or address says
what is wrong; a name already held is refused, whatever its case and with or without "Aber "; the
registration writes one APP_REGISTERED row that names the Administrator and holds neither the
secret nor its hash; and remove_app() removes the app and frees its name.

EVERY TEST ROLLS BACK. The act writes an Audit Trail row, and the audit table cannot be pruned.
"""
import base64
import hashlib
import json
import os
import re
import unittest
from pathlib import Path

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

FIXTURE = Path(__file__).resolve().parents[2] / "test-harness" / "fixtures" / "app-redirect-addresses.json"
API_ROW = "f1111111-0000-0000-0000-000000000007"
SWITCH = "security.require_mfa_for_managers"

ADMIN_ID = "a0d17070-0000-4000-8000-000000260a01"
MANAGER_ID = "a0d17070-0000-4000-8000-000000260a02"
OPERATOR_ID = "a0d17070-0000-4000-8000-000000260a03"
AUDITOR_ID = "a0d17070-0000-4000-8000-000000260a04"
NO_ROLE_ID = "a0d17070-0000-4000-8000-000000260a05"
MACHINE_ID = "a0d17070-0000-4000-8000-000000260a06"
PEOPLE = {ADMIN_ID: "Administrator", MANAGER_ID: "Shopfloor_Manager", OPERATOR_ID: "Operator",
          AUDITOR_ID: "Auditor", NO_ROLE_ID: None}

GRAFANA = "c0ffee00-0000-4000-8000-000000000001"
REDIRECT = "https://viewer.example.org/callback"
APP_KEYS = {"name", "registration_type", "client_type", "redirect_uris", "grant_types", "client_uri", "part_of_stack"}


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def hash_of(secret):
    """What GoTrue keeps and compares: the SHA-256 of the secret, base64url with no padding."""
    return base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest()).decode().rstrip("=")


class RegisterBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.register_app(text, text[], text)'), to_regclass('auth.oauth_clients');")
        if None in self.cur.fetchone():
            self.skipTest("0260 or the GoTrue fixture's auth.oauth_clients is not in this database")
        self.cur.execute("SELECT name, id FROM public.roles;")
        roles = dict(self.cur.fetchall())
        for user_id, role in PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@register.test"),
            )
            if role:
                self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                                 " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))
        self.cur.execute("INSERT INTO auth.users (id, created_at) VALUES (%s, now()) ON CONFLICT (id) DO NOTHING;",
                         (MACHINE_ID,))
        self.cur.execute(
            "INSERT INTO auth.oauth_clients (id, registration_type, client_name) VALUES (%s, 'manual', 'Aber Grafana')"
            " ON CONFLICT (id) DO UPDATE SET client_name = EXCLUDED.client_name, deleted_at = NULL;", (GRAFANA,))
        self.switch(False)

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def switch(self, on):
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("UPDATE public.system_settings SET value = %s::jsonb WHERE key = %s;",
                         ("true" if on else "false", SWITCH))

    def directory(self, url):
        self.cur.execute("UPDATE public.directory_services SET endpoint_url = %s WHERE id = %s;", (url, API_ROW))

    def attempt(self, sql, args=(), caller=ADMIN_ID, aal="aal2"):
        """(None, rows) when the statement ran as `caller`, as PostgREST would run it, or (the
        error, None), inside a savepoint."""
        claims = {"sub": caller, "role": "authenticated", "aal": aal} if caller else {}
        self.cur.execute("SAVEPOINT register_call;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims) if caller else "",))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error as err:
            self.cur.execute("ROLLBACK TO SAVEPOINT register_call;")
            self.cur.execute("RESET ROLE;")
            self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
            return err, None
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT register_call;")
        return None, rows

    def register(self, name="Shift Reports", uris=(REDIRECT,), kind="confidential", **kw):
        err, rows = self.attempt("SELECT public.register_app(%s, %s::text[], %s);", (name, list(uris), kind), **kw)
        if err:
            raise err
        return rows[0][0]

    def refused(self, name="Shift Reports", uris=(REDIRECT,), kind="confidential", **kw):
        err, _ = self.attempt("SELECT public.register_app(%s, %s::text[], %s);", (name, list(uris), kind), **kw)
        self.assertIsNotNone(err, "the registration was not refused")
        return err

    def client(self, app_id):
        self.cur.execute(
            "SELECT registration_type::text, client_type::text, token_endpoint_auth_method, grant_types,"
            "       redirect_uris, client_name, client_secret_hash, deleted_at, client_uri"
            "  FROM auth.oauth_clients WHERE id = %s;", (app_id,))
        row = self.cur.fetchone()
        return dict(zip(["registration_type", "client_type", "auth_method", "grant_types", "redirect_uris",
                         "client_name", "hash", "deleted_at", "client_uri"], row)) if row else None

    def trail(self, app_id):
        self.cur.execute(
            "SELECT action, changed_by::text, actor_source, new_data, old_data FROM public.audit_trail"
            " WHERE entity_type = 'oauth_clients' AND entity_id = %s ORDER BY recorded_at, id;", (app_id,))
        return self.cur.fetchall()


class TheAddressRule(RegisterBase):
    def test_it_answers_every_case_in_the_fixture(self):
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
        self.assertGreater(len(cases), 40)
        for case in cases:
            with self.subTest(uri=case["uri"], domain=case["domain"]):
                self.cur.execute("SELECT public.app_redirect_problem(%s, %s);", (case["uri"], case["domain"]))
                problem = self.cur.fetchone()[0]
                self.assertEqual(problem is None, case["ok"], f"{case['rule']}: {problem}")

    def test_a_refusal_says_what_is_wrong_in_words_that_follow_the_address(self):
        for uri, words in [
            ("https://viewer.example.org/cb#frag", "fragment"), ("https://*.example.org/cb", "wildcard"),
            ("https://viewer.example.org/a,b", "comma"), ("http://viewer.example.org/cb", "plain http"),
            ("myapp://callback", "https://"), ("https://user@viewer.example.org/cb", "user name"),
        ]:
            self.cur.execute("SELECT public.app_redirect_problem(%s, NULL);", (uri,))
            self.assertIn(words, self.cur.fetchone()[0], uri)

    def test_the_http_refusal_names_the_site_domain_when_there_is_one(self):
        self.cur.execute("SELECT public.app_redirect_problem('http://viewer.example.org/cb', 'plant.example');")
        self.assertIn("under plant.example", self.cur.fetchone()[0])
        self.cur.execute("SELECT public.app_redirect_problem('http://viewer.example.org/cb', NULL);")
        self.assertNotIn("under", self.cur.fetchone()[0])


class TheSiteDomain(RegisterBase):
    def test_it_is_the_api_address_without_its_first_label(self):
        for url, domain in [
            ("https://api.plant.example", "plant.example"),
            ("https://api.plant.example:8443/", "plant.example"),
            ("https://api.aber.localhost", "aber.localhost"),
            ("https://api.example.co.uk", "example.co.uk"),
            ("https://aber.example", "aber.example"),
            ("http://127.0.0.1:54321", None),
            ("http://localhost:54321", None),
            ("http://[::1]:54321", None),
            ("", None),
        ]:
            self.directory(url)
            self.cur.execute("SELECT public.site_domain();")
            self.assertEqual(self.cur.fetchone()[0], domain, url)

    def test_a_registration_allows_plain_http_under_it_and_only_there(self):
        self.directory("https://api.plant.example")
        app = self.register("Plant Viewer", ["http://viewer.plant.example/cb"])
        self.assertEqual(self.client(app["id"])["redirect_uris"], "http://viewer.plant.example/cb")
        err = self.refused("Other Viewer", ["http://viewer.example.org/cb"])
        self.assertIsInstance(err, psycopg2.errors.InvalidParameterValue)
        self.assertIn("under plant.example", err.diag.message_primary)
        self.directory("http://127.0.0.1:54321")
        err = self.refused("Plant Viewer Two", ["http://viewer.plant.example/cb"])
        self.assertIsInstance(err, psycopg2.errors.InvalidParameterValue)


class RegisteringAnApp(RegisterBase):
    def test_a_confidential_app_is_registered_as_the_stack_registers_its_own_and_gets_a_secret_once(self):
        app = self.register("Shift Reports", [REDIRECT, "http://10.1.2.3:3000/cb"])
        self.assertEqual(set(app), {"id", "name", "client_type", "redirect_uris", "client_secret"})
        self.assertEqual(app["name"], "Shift Reports")
        self.assertEqual(app["client_type"], "confidential")
        self.assertEqual(app["redirect_uris"], [REDIRECT, "http://10.1.2.3:3000/cb"])
        secret = app["client_secret"]
        self.assertRegex(secret, r"^[A-Za-z0-9_-]{43}$", "32 random bytes, base64url, no padding")
        row = self.client(app["id"])
        self.assertEqual(row["registration_type"], "manual")
        self.assertEqual(row["client_type"], "confidential")
        self.assertEqual(row["auth_method"], "client_secret_basic")
        self.assertEqual(row["grant_types"], "authorization_code,refresh_token")
        self.assertEqual(row["redirect_uris"], f"{REDIRECT},http://10.1.2.3:3000/cb")
        self.assertEqual(row["client_name"], "Shift Reports")
        self.assertEqual(row["hash"], hash_of(secret), "GoTrue compares the SHA-256 of the secret it is given")
        self.assertIsNone(row["deleted_at"])
        # Nothing the dashboard can read again holds it.
        err, rows = self.attempt("SELECT * FROM public.list_apps();")
        self.assertIsNone(err, err)
        self.assertNotIn(secret, json.dumps(rows, default=str))
        self.assertNotIn(row["hash"], json.dumps(rows, default=str))
        err, rows = self.attempt("SELECT * FROM public.app_approvals(%s);", (app["id"],))
        self.assertIsNone(err, err)
        self.assertEqual(rows, [])

    def test_a_public_app_is_registered_with_no_secret_and_no_hash(self):
        app = self.register("Plant Viewer", ["http://localhost:5173/cb"], "public")
        self.assertIsNone(app["client_secret"])
        self.assertEqual(app["client_type"], "public")
        row = self.client(app["id"])
        self.assertEqual((row["client_type"], row["auth_method"], row["hash"]), ("public", "none", None))
        self.assertEqual(row["registration_type"], "manual")

    def test_two_secrets_differ_and_so_do_two_ids(self):
        a = self.register("First", [REDIRECT])
        b = self.register("Second", [REDIRECT])
        self.assertNotEqual(a["client_secret"], b["client_secret"])
        self.assertNotEqual(a["id"], b["id"])

    def test_the_new_app_is_listed_as_one_an_administrator_added_and_not_part_of_the_stack(self):
        app = self.register()
        err, rows = self.attempt("SELECT id::text, client_name, registration_type, part_of_stack, client_type,"
                                 " redirect_uris, people_allowing FROM public.list_apps();")
        self.assertIsNone(err, err)
        listed = {r[0]: r for r in rows}
        self.assertEqual(listed[app["id"]][1:], ("Shift Reports", "manual", False, "confidential", [REDIRECT], 0))
        self.assertTrue(listed[GRAFANA][3], "the stack's own stays marked")

    def test_the_names_are_kept_as_given_apart_from_the_ends(self):
        app = self.register("  Shift   Reports  ")
        self.assertEqual(app["name"], "Shift   Reports")

    def test_up_to_ten_addresses(self):
        uris = [f"https://viewer{n}.example.org/cb" for n in range(10)]
        self.assertEqual(self.register("Ten", uris)["redirect_uris"], uris)
        err = self.refused("Eleven", uris + ["https://viewer10.example.org/cb"])
        self.assertIsInstance(err, psycopg2.errors.InvalidParameterValue)
        self.assertIn("between 1 and 10", err.diag.message_primary)


class TheAuditTrail(RegisterBase):
    def test_the_registration_is_one_row_that_names_the_administrator(self):
        app = self.register("Shift Reports", [REDIRECT, "http://10.1.2.3:3000/cb"])
        rows = self.trail(app["id"])
        self.assertEqual(len(rows), 1)
        action, changed_by, source, new_data, old_data = rows[0]
        self.assertEqual((action, changed_by, source), ("APP_REGISTERED", ADMIN_ID, "user"))
        self.assertIsNone(old_data)
        self.assertEqual(set(new_data), APP_KEYS)
        self.assertEqual((new_data["name"], new_data["registration_type"], new_data["client_type"], new_data["part_of_stack"]),
                         ("Shift Reports", "manual", "confidential", False))
        self.assertEqual(new_data["redirect_uris"], [REDIRECT, "http://10.1.2.3:3000/cb"])
        self.assertEqual(new_data["grant_types"], ["authorization_code", "refresh_token"])

    def test_no_audit_row_holds_the_secret_or_its_hash(self):
        app = self.register()
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE new_data::text LIKE %s OR old_data::text LIKE %s;",
                         (f"%{app['client_secret']}%", f"%{app['client_secret']}%"))
        self.assertEqual(self.cur.fetchone()[0], 0)
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE new_data::text LIKE %s;",
                         (f"%{self.client(app['id'])['hash']}%",))
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_a_refused_registration_writes_nothing_and_adds_no_app(self):
        self.cur.execute("SELECT count(*) FROM auth.oauth_clients;")
        before = self.cur.fetchone()[0]
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_type = 'oauth_clients';")
        rows_before = self.cur.fetchone()[0]
        self.refused("Bad", ["http://viewer.example.org/cb"])
        self.refused("Shift Reports", [REDIRECT], caller=OPERATOR_ID)
        self.cur.execute("SELECT count(*) FROM auth.oauth_clients;")
        self.assertEqual(self.cur.fetchone()[0], before)
        self.cur.execute("SELECT count(*) FROM public.audit_trail WHERE entity_type = 'oauth_clients';")
        self.assertEqual(self.cur.fetchone()[0], rows_before)

    def test_the_removal_is_a_row_naming_the_administrator_too(self):
        app = self.register()
        err, rows = self.attempt("SELECT public.remove_app(%s);", (app["id"],))
        self.assertIsNone(err, err)
        self.assertEqual(rows[0][0], {"name": "Shift Reports", "approvals_ended": 0, "sessions_ended": 0})
        actions = [(r[0], r[1]) for r in self.trail(app["id"])]
        self.assertEqual(actions, [("APP_REGISTERED", ADMIN_ID), ("APP_REMOVED", ADMIN_ID)])


class WhoMayRegister(RegisterBase):
    def test_only_an_administrator(self):
        for who, label in [(MANAGER_ID, "a Shopfloor Manager"), (OPERATOR_ID, "an Operator"), (AUDITOR_ID, "an Auditor"),
                           (NO_ROLE_ID, "a person with no role"), (MACHINE_ID, "a machine identity"), (None, "no identity")]:
            with self.subTest(who=label):
                err = self.refused(caller=who)
                self.assertIsInstance(err, psycopg2.errors.InsufficientPrivilege)
                self.assertIn("insufficient privileges", err.diag.message_primary)

    def test_the_roles_that_run_other_functions_may_not_run_it(self):
        self.cur.execute("SELECT has_function_privilege(r, 'public.register_app(text, text[], text)', 'EXECUTE')"
                         " FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r;")
        self.assertEqual([x[0] for x in self.cur.fetchall()], [False, True, False])

    def test_the_helpers_are_nobody_s_to_call(self):
        for fn in ("public.site_domain()", "public.app_redirect_problem(text, text)"):
            self.cur.execute("SELECT has_function_privilege(r, %s, 'EXECUTE')"
                             " FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r;", (fn,))
            self.assertEqual([x[0] for x in self.cur.fetchall()], [False, False, False], fn)


class WithASecondFactorRequired(RegisterBase):
    def test_a_session_that_gave_no_code_is_refused_while_the_switch_is_on(self):
        self.switch(True)
        err = self.refused(aal="aal1")
        self.assertIsInstance(err, psycopg2.errors.InsufficientPrivilege)
        self.assertEqual(err.diag.message_detail, "mfa_required")
        app = self.register(aal="aal2")
        self.assertEqual(app["name"], "Shift Reports")

    def test_it_is_not_asked_while_the_switch_is_off(self):
        self.switch(False)
        self.assertEqual(self.register(aal="aal1")["client_type"], "confidential")

    def test_the_second_factor_is_asked_before_anything_is_checked_or_written(self):
        self.switch(True)
        err = self.refused(name="", uris=["http://bad.example.org"], kind="neither", aal="aal1")
        self.assertEqual(err.diag.message_detail, "mfa_required")


class RefusingBadInput(RegisterBase):
    def invalid(self, message, **kw):
        err = self.refused(**kw)
        self.assertIsInstance(err, psycopg2.errors.InvalidParameterValue)
        self.assertIn(message, err.diag.message_primary)
        return err

    def test_a_name_of_one_to_eighty_characters_on_one_line(self):
        for name in ("", "   ", None, "x" * 81, "two\nlines", "tab\there"):
            with self.subTest(name=name):
                self.invalid("a name of 1 to 80 characters", name=name)
        self.assertEqual(self.register("x" * 80, [REDIRECT])["name"], "x" * 80)

    def test_public_or_confidential(self):
        for kind in ("", "private", "Public", None):
            with self.subTest(kind=kind):
                self.invalid("public or confidential", kind=kind)

    def test_one_to_ten_addresses(self):
        self.invalid("between 1 and 10", uris=[])
        err, _ = self.attempt("SELECT public.register_app('Reports', NULL, 'public');")
        self.assertIn("between 1 and 10", err.diag.message_primary)

    def test_each_address_is_named_with_what_is_wrong(self):
        for uris, message in [
            (["http://viewer.example.org/cb"], "the redirect address http://viewer.example.org/cb is plain http"),
            ([REDIRECT, "https://viewer.example.org/cb#x"], "https://viewer.example.org/cb#x has a fragment"),
            (["https://*.example.org/cb"], "has a wildcard"),
            ([""], "the redirect address (empty) is empty"),
            ([REDIRECT, REDIRECT], "is given twice"),
        ]:
            with self.subTest(uris=uris):
                self.invalid(message, uris=uris)

    def test_a_null_address_is_refused(self):
        err, _ = self.attempt("SELECT public.register_app('Reports', ARRAY[NULL]::text[], 'public');")
        self.assertIsInstance(err, psycopg2.errors.InvalidParameterValue)
        self.assertIn("(empty)", err.diag.message_primary)


class NamesAreUnique(RegisterBase):
    def taken(self, name):
        err = self.refused(name=name)
        self.assertIsInstance(err, psycopg2.errors.UniqueViolation)
        self.assertIn("is already registered", err.diag.message_primary)

    def test_a_name_in_use_is_taken_whatever_its_case(self):
        self.register("Shift Reports")
        self.taken("Shift Reports")
        self.taken("shift reports")
        self.taken("  SHIFT REPORTS ")

    def test_the_stack_s_names_are_taken_with_or_without_the_aber_prefix(self):
        for name in ("Aber Grafana", "Grafana", "aber   grafana", "ABER Grafana"):
            with self.subTest(name=name):
                self.taken(name)

    def test_a_removed_app_s_name_is_free_again(self):
        first = self.register("Shift Reports")
        err, _ = self.attempt("SELECT public.remove_app(%s);", (first["id"],))
        self.assertIsNone(err, err)
        second = self.register("Shift Reports")
        self.assertNotEqual(first["id"], second["id"])

    def test_a_similar_name_is_not_taken(self):
        self.register("Shift Reports")
        self.assertEqual(self.register("Shift Reports 2")["name"], "Shift Reports 2")


class TheSchema(RegisterBase):
    def test_register_app_is_security_definer_with_its_search_path_pinned(self):
        self.cur.execute("SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'public.register_app(text, text[], text)'::regprocedure;")
        definer, config = self.cur.fetchone()
        self.assertTrue(definer)
        self.assertIn("search_path=public", config)

    def test_it_calls_require_mfa_and_keeps_dynamic_registration_off(self):
        self.cur.execute("SELECT prosrc FROM pg_proc WHERE oid = 'public.register_app(text, text[], text)'::regprocedure;")
        source = self.cur.fetchone()[0]
        self.assertIn("PERFORM public.require_mfa();", source)
        self.assertRegex(source, r"'manual'")
        self.assertIsNone(re.search(r"'dynamic'", source), "this registers by hand, never as dynamic")


if __name__ == "__main__":
    unittest.main()
