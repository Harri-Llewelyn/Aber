"""
Naming a person in the audit trail (0116).

WHAT THIS IS DEFENDING. `list_user_accounts()` is a read surface over `auth.users`, reached from the
browser, returning email addresses. Every property that makes that safe lives in the function body
rather than in a grant -- `authenticated` holds EXECUTE and the function decides -- so a gate that
stops working fails OPEN, silently, with the page looking exactly as it should.

THE GATE IS NOT ADMINISTRATOR-ONLY, deliberately: it matches `digital_thread_select_security`, the
policy on the rows these names label. An Auditor can read the role-assignment lane, and refusing
them the names would leave them reading uuids beside an Administrator reading people -- one record
told two ways. Both directions are asserted, because "admits the right roles" and "refuses the rest"
fail independently.

MEMBERSHIP IS `is_machine_principal()` AND NOT A SECOND TEST. 0048's header says a second definition
of "is this a service account" would be worse than the bug it fixed, and this function is exactly
where a second one would have gone. The suite asserts the two agree on every row rather than
asserting the shape of a WHERE clause.

SELF-SEEDED, NOT THE DEMO PERSONAS. CI's RLS job applies the migrations and deliberately NOT
seed.sql -- the base image's legacy `auth.users` lacks columns the seed writes -- so
`admin@aber.local` does not exist there. A suite depending on it passes locally and fails in
CI, where the failure looks like the gate and is actually the fixture. Same approach, and the same
reason, as test_system_settings_rls.py and test_user_roles_rls.py.
"""

import os
import unittest
import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# One fixture identity per role. The ids differ in their FIRST block rather than their last: this
# suite does not derive a sparkplug id, but every pinned uuid in this repository follows that rule
# because the ones that did not collided (see supabase/README.md on sparkplug_id).
ADMIN_ID = "acc0a1d1-0000-4000-8000-000000000116"
AUDITOR_ID = "acc0a1d2-0000-4000-8000-000000000116"
MANAGER_ID = "acc0a1d3-0000-4000-8000-000000000116"
OPERATOR_ID = "acc0a1d4-0000-4000-8000-000000000116"

FIXTURE_ROLES = {
    ADMIN_ID: "Administrator",
    AUDITOR_ID: "Auditor",
    MANAGER_ID: "Shopfloor_Manager",
    OPERATOR_ID: "Operator",
}


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def ensure_auth_user(cur, user_id, label):
    """
    Make `user_id` exist in `auth.users`, SHAPED LIKE A PERSON.

    The email is what makes it one: `is_machine_principal()` is "no email, no password, no identity
    provider", so an id-only row is indistinguishable from one of the stack's own service
    identities -- and 0080 refuses a role to anything that predicate recognises, which would leave
    the fixture unable to hold the role it is testing. It is also what this suite is about: a row
    with no email is not listed as a person by anything here.

    auth.users differs between GoTrue's real schema and the base image's legacy one, so the fuller
    shape is tried first and the primary key alone second, each savepointed. Copied from
    test_system_settings_rls.py rather than shared: these suites are standalone files, and the
    duplication is the convention.
    """
    for columns, values in (
        ("(instance_id, id, aud, role, email)",
         ("00000000-0000-0000-0000-000000000000", user_id, "authenticated",
          "authenticated", f"{label}@0116.test")),
        ("(id)", (user_id,)),
    ):
        cur.execute("SAVEPOINT ensure_user;")
        try:
            cur.execute(
                f"INSERT INTO auth.users {columns} VALUES "
                f"({', '.join(['%s'] * len(values))}) ON CONFLICT (id) DO NOTHING;",
                values,
            )
            cur.execute("RELEASE SAVEPOINT ensure_user;")
            return
        except psycopg2.Error:
            cur.execute("ROLLBACK TO SAVEPOINT ensure_user;")
    raise RuntimeError(
        f"could not create auth.users row {user_id}; the tests that act as this user cannot run"
    )


def drop_fixture_principals(user_ids):
    """
    Remove what setUpClass committed. It has to commit -- the fixture must be visible to the fresh
    connections each test opens -- and a fixture that commits and never cleans up is a permanent
    account, listed on the Access Control page as somebody nobody created.

    The ROLE_REVOKED rows this generates are left alone: dropping a grant is audited, and a suite
    that deletes its own audit rows every run establishes that audit history is tidyable by
    whoever finds it inconvenient. See test_system_settings_rls.py, which says it at length.
    """
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM public.user_roles WHERE user_id = ANY(%s);",
                        ([str(u) for u in user_ids],))
            cur.execute("DELETE FROM auth.users WHERE id = ANY(%s::uuid[]);",
                        ([str(u) for u in user_ids],))
        conn.commit()
    except psycopg2.Error as err:
        conn.rollback()
        print(f"warning: could not remove fixture principals {list(user_ids)}: {err}")
    finally:
        conn.close()


class UserAccountsListing(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                # BY NAME, not by a hardcoded id: `roles.id` is assigned by a sequence in 0001, and
                # a suite that hardcodes 1 == Administrator is asserting a fact about that sequence.
                cur.execute("SELECT id, name FROM public.roles WHERE name = ANY(%s);",
                            (sorted(set(FIXTURE_ROLES.values())),))
                by_name = {name: rid for rid, name in cur.fetchall()}
                for needed in set(FIXTURE_ROLES.values()):
                    if needed not in by_name:
                        raise RuntimeError(f"role {needed!r} is missing; 0001 did not run cleanly.")

                for user_id, role in FIXTURE_ROLES.items():
                    ensure_auth_user(cur, user_id, role.lower())
                    cur.execute(
                        "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                        " ON CONFLICT (user_id, role_id) DO NOTHING;",
                        (user_id, by_name[role]),
                    )
                conn.commit()

                # Asserted rather than assumed: if has_role() cannot see these grants, every
                # refusal below would "pass" for the wrong reason.
                cur.execute(
                    "SELECT ur.user_id, r.name FROM public.user_roles ur"
                    "  JOIN public.roles r ON r.id = ur.role_id"
                    " WHERE ur.user_id = ANY(%s);", ([str(u) for u in FIXTURE_ROLES],)
                )
                granted = {str(u): r for u, r in cur.fetchall()}
                for user_id, role in FIXTURE_ROLES.items():
                    if granted.get(user_id) != role:
                        raise RuntimeError(
                            f"fixture user {user_id} holds {granted.get(user_id)!r}, not {role!r}"
                        )
        finally:
            conn.close()

    @classmethod
    def tearDownClass(cls):
        drop_fixture_principals(tuple(FIXTURE_ROLES))

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()
        self.conn.close()

    def as_user(self, user_id):
        """
        Become `authenticated` with a JWT subject, THE WAY PostgREST 12.2 ACTUALLY DOES IT: only
        `request.jwt.claims`. test_system_settings_rls.py records what setting the legacy GUC as
        well cost the last time somebody reasoned it kept the test honest.
        """
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute(
            'SET LOCAL "request.jwt.claims" = %s;', ('{"sub": "%s"}' % user_id,)
        )

    def accounts_as(self, user_id):
        self.as_user(user_id)
        self.cur.execute("SELECT user_id, email FROM public.list_user_accounts();")
        return self.cur.fetchall()

    # -----------------------------------------------------------------------------------------
    # Who may ask
    # -----------------------------------------------------------------------------------------
    def test_an_administrator_is_given_the_people_who_can_reach_the_stack(self):
        by_id = {str(u): e for u, e in self.accounts_as(ADMIN_ID)}
        for seeded in FIXTURE_ROLES:
            self.assertIn(seeded, by_id, f"{seeded} is a person and was not listed")
        self.assertEqual(by_id[ADMIN_ID], "administrator@0116.test")

    def test_an_auditor_is_given_the_same_list(self):
        """
        The reason the gate is not Administrator-only. An Auditor reads the role-assignment lane;
        naming it for one of them and not the other is the same record told two ways.
        """
        admin = sorted((str(u), e) for u, e in self.accounts_as(ADMIN_ID))
        self.tearDown()
        self.setUp()
        auditor = sorted((str(u), e) for u, e in self.accounts_as(AUDITOR_ID))
        self.assertEqual(admin, auditor)

    def test_a_shopfloor_manager_is_refused(self):
        # Refused, not empty. An empty list reads as "there are no users" -- a claim this function
        # must never make to somebody who simply may not ask.
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.accounts_as(MANAGER_ID)

    def test_an_operator_is_refused(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.accounts_as(OPERATOR_ID)

    def test_an_unauthenticated_caller_cannot_reach_the_body_at_all(self):
        """
        `anon` is stopped by the missing grant rather than by the gate inside. Both layers matter:
        the gate is a role check, so were EXECUTE ever granted to PUBLIC, `has_role()` on a session
        with no subject would be the only thing left.
        """
        self.cur.execute("SET LOCAL ROLE anon;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT * FROM public.list_user_accounts();")

    # -----------------------------------------------------------------------------------------
    # What comes back
    # -----------------------------------------------------------------------------------------
    def test_membership_is_exactly_what_is_machine_principal_says_it_is(self):
        """
        Row for row against the predicate rather than against the shape of a WHERE clause, so a
        second definition of "is this a service account" cannot open up between them (0048).
        """
        self.cur.execute(
            "SELECT count(*) FROM auth.users u WHERE NOT public.is_machine_principal(u.id);"
        )
        expected = self.cur.fetchone()[0]
        self.assertGreaterEqual(expected, len(FIXTURE_ROLES))

        self.tearDown()
        self.setUp()
        self.assertEqual(len(self.accounts_as(ADMIN_ID)), expected)

    def test_a_machine_identity_is_not_listed_as_a_person(self):
        """
        The half that leaks rather than hides, named on its own so a failure says which way round
        it went. The fixture is an id-only row: no email, no password, no identity provider, which
        is what the stack's own service identities look like.
        """
        machine = "acc0a1d9-0000-4000-8000-000000000116"
        self.cur.execute("INSERT INTO auth.users (id) VALUES (%s);", (machine,))
        self.cur.execute("SELECT public.is_machine_principal(%s);", (machine,))
        self.assertTrue(self.cur.fetchone()[0], "the fixture is not shaped like a machine")

        listed = [str(u) for u, _ in self.accounts_as(ADMIN_ID)]
        self.assertNotIn(machine, listed)

    # -----------------------------------------------------------------------------------------
    # The label and the search are the same claim
    # -----------------------------------------------------------------------------------------
    def test_the_email_that_labels_a_lane_also_finds_it(self):
        """
        THE INVARIANT 0115 STATES AND 0116 NEARLY BROKE. The Digital Thread labels a
        role-assignment lane with the person, and a lane the timeline draws and the search cannot
        match is the drift that file's shared field list exists to prevent -- one which would not
        have raised anything, because a search that matches nothing looks the same as one that
        matches nothing.

        The fixture makes this checkable for free: granting a role fires `log_role_assignment()`,
        so every identity in `setUpClass` already has a ROLE_GRANTED row keyed by its user id.
        """
        self.as_user(ADMIN_ID)
        self.cur.execute(
            "SELECT (public.digital_thread_page(p_limit => 5, p_include_purged => true,"
            "                                   p_search => %s) ->> 'total_matching')::bigint",
            ("administrator@0116.test",),
        )
        self.assertGreater(
            self.cur.fetchone()[0], 0,
            "the email that labels the lane does not find it -- p_search cannot reach the person, "
            "and a role-assignment payload names the role rather than who it was granted to",
        )

    def test_the_page_does_not_fail_for_somebody_who_may_not_name_a_person(self):
        """
        The matcher returns an empty array rather than raising, and this is why: it is ONE DISJUNCT
        of a search. Refusing would fail the whole page for an Operator, turning "your search
        matched nothing here" into "the Digital Thread is broken" -- on a lane they cannot read
        either way.
        """
        self.as_user(OPERATOR_ID)
        self.cur.execute(
            "SELECT (public.digital_thread_page(p_limit => 1, p_include_purged => true,"
            "                                   p_search => %s) ->> 'total_matching')::bigint",
            ("administrator@0116.test",),
        )
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_it_returns_the_id_and_the_email_and_nothing_else(self):
        """
        A read surface over the auth schema returns the least that does the job. A column added
        here is a column every Administrator's browser receives, so it is a decision rather than a
        convenience.
        """
        self.cur.execute(
            "SELECT pg_get_function_result(p.oid) FROM pg_proc p"
            "  JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public' AND p.proname = 'list_user_accounts'"
        )
        self.assertEqual(self.cur.fetchone()[0], "TABLE(user_id uuid, email text)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
