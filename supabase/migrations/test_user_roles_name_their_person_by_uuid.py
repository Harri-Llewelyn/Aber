# suite:
#   lanes: db
#   why: user_roles.user_id is a uuid with a foreign key to auth.users, so a role for an id with no
#     account is refused and goes with its account; that 0001's head converts 1.7.0's text column
#     once, deleting and counting the rows that name no account, and a second boot changes nothing;
#     and that a sign-in, Add Person, a role change, has_role() and the machine guard answer as
#     before after each boot. An empty database never meets the conversion, so the suite rebuilds
#     1.7.0's column.

"""
user_roles names its person by uuid, with a foreign key to auth.users (0001, 0165, 0166, 0177).

    python supabase/migrations/test_user_roles_name_their_person_by_uuid.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

Before 1.8, user_roles.user_id was text with no foreign key. What is held here:

  * the column is a uuid referencing auth.users ON DELETE CASCADE: a role for an id with no
    account is refused, and deleting the account deletes its role, with its ROLE_REVOKED row;
  * a machine principal is still refused a role, by the trigger and by the People acts;
  * on an upgrade, 0001's head converts the column. A row whose user_id is not a uuid, or names
    no account, is deleted and counted in a NOTICE, and the uuid-shaped ones are audited. Then the
    key is added and the policy stated again, 0001's and 0177's;
  * after the first boot and after a second: a sign-in carries the person's role, Add Person and
    a role change write the row, has_role() admits and refuses as before, and the policy shows a
    person their own row only;
  * a later boot that finds the key missing deletes what names no account, so the key goes back.

An upgrade is 1.7.0's column, policy and audit trigger rebuilt inside the test's transaction, as
test_a_cell_has_no_grafana_url_column.py rebuilds 1.7.0's column, and then 0001's and 0177's
blocks for the table replayed. Every test rolls back.
"""
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

MIGRATIONS = Path(__file__).resolve().parent
BASELINE = (MIGRATIONS / "0001_baseline_schema.sql").read_text(encoding="utf-8")
POLICIES = (MIGRATIONS / "0177_policies_check_the_caller_once_per_query.sql").read_text(encoding="utf-8")

ADMIN_ID = "1194b000-0000-4000-8000-0000000001a1"
OPERATOR_ID = "1194c000-0000-4000-8000-0000000001c1"
NEWCOMER_ID = "1194d000-0000-4000-8000-0000000001d1"
MACHINE_ID = "1194e000-0000-4000-8000-0000000001e1"
GONE_ID = "1194f000-0000-4000-8000-0000000001f1"
NOT_A_UUID = "not-a-uuid"

FOREIGN_KEY = "FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE"
POLICY = "user_roles_select_own_or_privileged"
# The policy as 1.7.0 left it, from 0177.
POLICY_1_7_0 = (
    "CREATE POLICY user_roles_select_own_or_privileged ON public.user_roles FOR SELECT TO authenticated"
    " USING (((user_id = (( SELECT auth.uid() AS uid))::text) OR ( SELECT public.has_role("
    "ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]) AS has_role)));"
)


def block(source, pattern, name):
    found = re.search(pattern, source, re.S)
    if found is None:
        raise AssertionError(f"{name} is no longer where this suite reads it")
    return found.group(0)


CONVERSION = block(BASELINE, r"DO \$user_id_uuid\$\n.*?\n\$user_id_uuid\$;", "0001's conversion block")
KEY_GUARD = block(
    BASELINE,
    r"DO \$c\$ BEGIN\n\n  IF EXISTS \(SELECT 1 FROM pg_constraint\n\s+WHERE conname = 'user_roles_user_id_fkey'.*?END \$c\$;",
    "0001's user_roles_user_id_fkey guard",
)
AUDIT_TRIGGER = block(
    BASELINE,
    r"CREATE OR REPLACE FUNCTION public\.log_role_assignment\(\).*?\n\$\$;",
    "0001's log_role_assignment()",
)
CALL = r"SELECT public\.replay_policy\('public\.user_roles', 'user_roles_select_own_or_privileged', \$ddl\$\n.*?\n\$ddl\$[^;]*\);"
POLICY_0001 = block(BASELINE, CALL, "0001's call for the user_roles policy")
POLICY_0177 = block(POLICIES, CALL, "0177's call for the user_roles policy")
STATEMENT_0177 = POLICY_0177.split("\n")[1]


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class UserRolesBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT id, name FROM public.roles;")
        self.roles = {name: rid for rid, name in self.cur.fetchall()}
        # The newcomer's account is new, so Add Person accepts it.
        for user_id, age in ((ADMIN_ID, "1 day"), (OPERATOR_ID, "1 day"), (NEWCOMER_ID, "0 seconds")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now() - %s::interval);",
                (user_id, f"{user_id}@roles.test", age),
            )
        # A machine identity: no email, no password, no identity provider.
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at) VALUES (%s, NULL, NULL, now());",
            (MACHINE_ID,),
        )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- helpers ----------------------------------------------------------------------------------

    def one(self, sql, args=()):
        self.cur.execute(sql, args)
        return self.cur.fetchone()[0]

    def grant(self, user_id, role):
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s);",
                         (user_id, self.roles[role]))

    def roles_of(self, user_id):
        self.cur.execute(
            "SELECT r.name FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id"
            " WHERE ur.user_id::text = %s ORDER BY r.name;", (user_id,))
        return [r[0] for r in self.cur.fetchall()]

    def call(self, user_id, sql, args=()):
        """`sql` as `user_id` through the API role. A refusal rolls back to the savepoint and is
        raised. The claims are cleared after, so what follows runs as the migration again."""
        self.cur.execute("SAVEPOINT as_person;")
        try:
            self.cur.execute("SET LOCAL ROLE authenticated;")
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": user_id, "role": "authenticated"}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT as_person;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT as_person;")
        return rows

    def refused(self, error, sql, args=()):
        self.cur.execute("SAVEPOINT refused;")
        with self.assertRaises(error) as caught:
            self.cur.execute(sql, args)
        self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
        return str(caught.exception)

    def revoked_rows(self, user_id):
        self.cur.execute(
            "SELECT action, actor_source FROM public.audit_trail"
            " WHERE entity_type = 'user_roles' AND entity_id = %s AND action = 'ROLE_REVOKED';",
            (user_id,))
        return self.cur.fetchall()

    # -- what holds after any boot ----------------------------------------------------------------

    def assert_the_people_acts_hold(self):
        # The column, its key and the policy in its final form.
        self.assertEqual(self.one(
            "SELECT format_type(atttypid, atttypmod) FROM pg_attribute"
            " WHERE attrelid = 'public.user_roles'::regclass AND attname = 'user_id';"), "uuid")
        self.assertEqual(self.one(
            "SELECT public.live_constraint_definition('public.user_roles', 'user_roles_user_id_fkey');"),
            FOREIGN_KEY)
        self.assertEqual(self.one(
            "SELECT public.live_policy_statement('public.user_roles', %s);", (POLICY,)), STATEMENT_0177)

        # A sign-in: the token hook puts the role in the claims GoTrue sends, and none for a
        # person without one.
        hook = ("SELECT public.custom_access_token_hook(jsonb_build_object('user_id', %s::text,"
                " 'claims', jsonb_build_object('sub', %s::text, 'app_metadata', '{\"provider\": \"email\"}'::jsonb)))"
                " #> '{claims,app_metadata}';")
        self.cur.execute(hook, (ADMIN_ID, ADMIN_ID))
        self.assertEqual(self.cur.fetchone()[0], {"provider": "email", "role": "Administrator"})
        self.cur.execute(hook, (NEWCOMER_ID, NEWCOMER_ID))
        self.assertEqual(self.cur.fetchone()[0], {"provider": "email"})

        # Add Person (the insert) and a role change (the update), as an Administrator.
        self.call(ADMIN_ID, "SELECT public.record_person_added(%s, 'Auditor', false);", (NEWCOMER_ID,))
        self.assertEqual(self.roles_of(NEWCOMER_ID), ["Auditor"])
        self.assertEqual(self.call(ADMIN_ID, "SELECT public.set_person_role(%s, 'Shopfloor_Manager');",
                                   (OPERATOR_ID,)), [(True,)])
        self.assertEqual(self.roles_of(OPERATOR_ID), ["Shopfloor_Manager"])
        self.assertIn(OPERATOR_ID, [str(r[0]) for r in self.call(ADMIN_ID, "SELECT user_id FROM public.list_people()"
                                                                 " WHERE role = 'Shopfloor_Manager';")])

        # has_role() admits and refuses as before; the policy shows a person only their own row.
        self.assertEqual(self.call(NEWCOMER_ID,
                                   "SELECT public.has_role(ARRAY['Auditor']), public.has_role(ARRAY['Administrator']),"
                                   " public.has_authority(ARRAY['audit_trail:read']);"),
                         [(True, False, True)])
        self.assertEqual(self.call(NEWCOMER_ID, "SELECT user_id::text FROM public.user_roles;"), [(NEWCOMER_ID,)])
        everyone = [r[0] for r in self.call(ADMIN_ID, "SELECT user_id::text FROM public.user_roles;")]
        self.assertTrue({ADMIN_ID, OPERATOR_ID, NEWCOMER_ID} <= set(everyone), everyone)

        # A machine principal is still refused a role: by the People acts, and by the trigger.
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.call(ADMIN_ID, "SELECT public.set_person_role(%s, 'Operator');", (MACHINE_ID,))
        message = self.refused(psycopg2.errors.InsufficientPrivilege,
                               "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s);",
                               (MACHINE_ID, self.roles["Operator"]))
        self.assertIn(f"{MACHINE_ID} is a machine principal", message)


class TheColumnIsAUuid(UserRolesBase):
    """A fresh install: the chain as this database holds it."""

    def test_the_people_acts_hold(self):
        self.grant(ADMIN_ID, "Administrator")
        self.grant(OPERATOR_ID, "Operator")
        self.assert_the_people_acts_hold()

    def test_a_role_for_an_id_with_no_account_is_refused(self):
        message = self.refused(psycopg2.errors.ForeignKeyViolation,
                               "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s);",
                               (GONE_ID, self.roles["Operator"]))
        self.assertIn("user_roles_user_id_fkey", message)

    def test_deleting_the_account_deletes_its_role_and_says_so(self):
        self.grant(OPERATOR_ID, "Operator")
        self.cur.execute("DELETE FROM auth.users WHERE id = %s;", (OPERATOR_ID,))
        self.assertEqual(self.roles_of(OPERATOR_ID), [])
        self.assertEqual(self.revoked_rows(OPERATOR_ID), [("ROLE_REVOKED", "migration")])

    def test_the_machine_guard_asks_the_predicate_with_no_shape_check(self):
        body = self.one("SELECT prosrc FROM pg_proc"
                        " WHERE oid = 'public.refuse_role_for_machine_principal()'::regprocedure;")
        self.assertIn("IF public.is_machine_principal(NEW.user_id) THEN", body)
        self.assertNotIn("~*", body)


class AnUpgradeConvertsTheColumn(UserRolesBase):
    """1.7.0's shape, rebuilt in the transaction, then the first boot and a second."""

    def setUp(self):
        super().setUp()
        self.grant(ADMIN_ID, "Administrator")
        self.grant(OPERATOR_ID, "Operator")
        self.cur.execute("ALTER TABLE public.user_roles DROP CONSTRAINT user_roles_user_id_fkey;")
        self.cur.execute("DROP POLICY user_roles_select_own_or_privileged ON public.user_roles;")
        self.cur.execute("ALTER TABLE public.user_roles ALTER COLUMN user_id TYPE text USING user_id::text;")
        self.cur.execute(POLICY_1_7_0)
        # 1.7.0's audit trigger cast the text id to the audit row's uuid.
        self.cur.execute("SELECT pg_get_functiondef('public.log_role_assignment()'::regprocedure);")
        definition = self.cur.fetchone()[0]
        self.assertEqual(definition.count("    v_row.user_id,\n"), 1)
        self.cur.execute(definition.replace("    v_row.user_id,\n", "    v_row.user_id::uuid,\n"))
        # Rows that grant nothing: an account deleted while its role stayed, and a value that is no
        # uuid at all, which only a load with the triggers off could have written.
        self.cur.execute("ALTER TABLE public.user_roles DISABLE TRIGGER USER;")
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s), (%s, %s);",
                         (GONE_ID, self.roles["Administrator"], NOT_A_UUID, self.roles["Administrator"]))
        self.cur.execute("ALTER TABLE public.user_roles ENABLE TRIGGER USER;")

    def boot(self):
        """0001's blocks for the table in file order, then 0177's. The NOTICEs they raised."""
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        del self.conn.notices[:]
        for sql in (CONVERSION, AUDIT_TRIGGER, KEY_GUARD, POLICY_0001, POLICY_0177):
            self.cur.execute(sql)
        return [n.strip() for n in self.conn.notices]

    def test_the_first_boot_deletes_the_orphans_and_a_second_changes_nothing(self):
        notices = self.boot()
        self.assertIn("NOTICE:  user_roles: deleted 1 row(s) whose user_id is not a uuid: {not-a-uuid}", notices)
        self.assertIn("NOTICE:  user_roles: deleted 1 row(s) naming no account", notices)
        self.assertIn("NOTICE:  user_roles: user_id is now a uuid", notices)
        self.assertEqual(self.one("SELECT count(*) FROM public.user_roles WHERE user_id::text IN (%s, %s);",
                                  (GONE_ID, NOT_A_UUID)), 0)
        self.assertEqual(self.roles_of(ADMIN_ID), ["Administrator"])
        self.assertEqual(self.roles_of(OPERATOR_ID), ["Operator"])
        # The uuid-shaped orphan's removal is in its lane, as the migration's.
        self.assertEqual(self.revoked_rows(GONE_ID), [("ROLE_REVOKED", "migration")])

        key = self.one("SELECT oid FROM pg_constraint WHERE conname = 'user_roles_user_id_fkey';")
        policy = self.one("SELECT oid FROM pg_policy WHERE polname = %s;", (POLICY,))
        again = self.boot()
        self.assertEqual([n for n in again if "user_roles:" in n or "policy" in n], [])
        self.assertEqual(self.one("SELECT oid FROM pg_constraint WHERE conname = 'user_roles_user_id_fkey';"), key)
        self.assertEqual(self.one("SELECT oid FROM pg_policy WHERE polname = %s;", (POLICY,)), policy)

    def test_the_people_acts_hold_after_the_first_boot(self):
        self.boot()
        self.assert_the_people_acts_hold()

    def test_the_people_acts_hold_after_a_second_boot(self):
        self.boot()
        self.boot()
        self.assert_the_people_acts_hold()

    def test_a_boot_that_finds_the_key_missing_deletes_what_names_no_account(self):
        self.boot()
        # An account deleted between the conversion and the key, as on a boot that then failed.
        self.cur.execute("ALTER TABLE public.user_roles DROP CONSTRAINT user_roles_user_id_fkey;")
        self.cur.execute("DELETE FROM auth.users WHERE id = %s;", (OPERATOR_ID,))
        self.assertEqual(self.roles_of(OPERATOR_ID), ["Operator"])
        notices = self.boot()
        self.assertIn("NOTICE:  user_roles: deleted 1 row(s) naming no account", notices)
        self.assertNotIn("NOTICE:  user_roles: user_id is now a uuid", notices)
        self.assertEqual(self.roles_of(OPERATOR_ID), [])
        self.assertEqual(self.one(
            "SELECT public.live_constraint_definition('public.user_roles', 'user_roles_user_id_fkey');"),
            FOREIGN_KEY)


if __name__ == "__main__":
    unittest.main(verbosity=2)
