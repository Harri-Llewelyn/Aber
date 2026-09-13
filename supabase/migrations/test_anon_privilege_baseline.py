"""
`anon` holds EXECUTE on nothing in `public` except PostgREST's pre-request hook.

=================================================================================================
THIS IS A FRESH-BOOT-ONLY FAULT, WHICH IS WHY IT NEEDS A SUITE RATHER THAN AN EYE.

PostgreSQL grants EXECUTE on every new function to PUBLIC, and `anon` is a member of PUBLIC. So a
migration that writes `GRANT EXECUTE ... TO authenticated` and no REVOKE has not narrowed anything
-- it has restated a permission everybody already had. 0076 shipped exactly that for
`assert_principal_not_revoked()` and it reached CI.

AND IT IS INVISIBLE ON A LONG-LIVED STACK. 0001's section 6 sweep revokes PUBLIC and `anon` from
every function in `public`, but it runs in 0001 -- BEFORE the migrations that create these
functions. So:

    boot 1   0001 sweeps what exists, then 0076 creates the function -> PUBLIC's grant stands
    boot 2+  0001 sweeps and now catches it; 0076's CREATE OR REPLACE preserves privileges

`CREATE OR REPLACE FUNCTION` does not reset an ACL, so the leak heals on the second boot and can
never be reproduced on a development stack that has been restarted once. It is present on exactly
one kind of installation: A NEW ONE. 0001's own comment records the same shape biting eleven
trigger bodies for the same reason.

That is what makes this worth asserting HERE rather than only in validate.py's check 13a: the
database suites run against a throwaway Postgres, which is a first boot every single time.

=================================================================================================
THE ONE EXEMPTION IS NOT A RELAXATION.

`auth_pre_request()` is PostgREST's `db-pre-request` hook -- the chart names it in
PGRST_DB_PRE_REQUEST -- and PostgREST runs it AFTER switching to the request's role. For an
unauthenticated request that role is `anon`, so revoking it does not harden anything: it takes the
whole anonymous API surface down, /ping included. The exemption is matched on name AND arity so an
overload cannot arrive under its cover.
"""

import os
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# Keep in step with ingestion/validate.py check 13a, which asserts the same baseline against a
# running stack. Two entries in two places is deliberate: this one runs on every `npm run test:db`
# in seconds, that one runs against the real PostgREST and proves the stack still serves anonymous
# requests with the exemption in place. Neither subsumes the other.
ANON_EXECUTE_ALLOWED = {("auth_pre_request", 0)}


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class AnonPrivilegeBaseline(unittest.TestCase):
    """The whole schema, not a list of functions somebody remembered to add."""

    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def anon_executable(self):
        with self.conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.proname, p.pronargs
                  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public'
                   AND has_function_privilege('anon', p.oid, 'EXECUTE')
                 ORDER BY p.proname, p.pronargs
                """
            )
            return [(name, int(nargs)) for name, nargs in cur.fetchall()]

    def test_anon_can_execute_nothing_it_is_not_allowed(self):
        leaked = sorted(
            f"{name}/{nargs}"
            for name, nargs in self.anon_executable()
            if (name, nargs) not in ANON_EXECUTE_ALLOWED
        )
        self.assertEqual(
            leaked, [],
            "anon holds EXECUTE in public on: " + ", ".join(leaked) + ". A new function is "
            "EXECUTE-able by PUBLIC unless its migration revokes it -- add "
            "`REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon;` BEFORE the GRANT, as "
            "revoke_service_principal() and reinstate_service_principal() do.",
        )

    def test_the_pre_request_hook_is_still_reachable_by_anon(self):
        """
        THE OTHER DIRECTION, AND IT FAILS LOUDLY RATHER THAN QUIETLY. A blanket revoke that swept
        this up would leave every anonymous PostgREST request erroring at the hook -- a total
        outage produced by a change that reads like hardening.
        """
        self.assertIn(
            ("auth_pre_request", 0), self.anon_executable(),
            "anon lost EXECUTE on the PostgREST db-pre-request hook; every anonymous request "
            "through PostgREST will fail until it is granted back.",
        )

    def test_the_exemption_is_matched_on_arity_not_just_name(self):
        """
        An overload must not inherit the exemption. Asserted against the allow-list itself rather
        than by creating a function, so the suite writes nothing.
        """
        self.assertNotIn(("auth_pre_request", 1), ANON_EXECUTE_ALLOWED)
        self.assertTrue(
            all(isinstance(entry, tuple) and len(entry) == 2 for entry in ANON_EXECUTE_ALLOWED),
            "every allow-list entry must be (name, arity); a bare name would exempt every overload",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
