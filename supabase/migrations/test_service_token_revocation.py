"""
0074 -- revocation for the long-lived service tokens 0043 records.

=================================================================================================
THE FAIL-OPEN TESTS COME FIRST, AND THAT ORDERING IS THE POINT OF THIS FILE.

`auth_pre_request()` runs before EVERY PostgREST request, in the caller's role. If it raises when
it should not, the entire API is down -- the correct direction for a security control and a total
outage all the same. The retired revocable-tokens roadmap item names the three cases that have to be proven before anything
depends on it: an empty denylist, a token carrying no `jti` at all, and the function missing
entirely.

Two of those are asserted here. THE THIRD -- the function missing -- IS NOT A DATABASE TEST: it is
a question about what PostgREST does when `PGRST_DB_PRE_REQUEST` names something that does not
exist, and it is answered by starting PostgREST that way.

IT HAS NOW BEEN MEASURED, and the answer is worse than the roadmap assumed. A throwaway
postgrest/postgrest:v14.12 was started against this database naming a function that does not exist:

    /live                200
    /ready               200
    GET /gateways        404  {"code":"42883","message":"function ... does not exist"}

PostgREST does NOT refuse to boot. The schema cache loads, the container reports running, and both
admin probes report healthy while every data request fails -- as a 404, so a monitor watching for
5xx sees nothing and a Kubernetes readiness probe keeps the pod in service. A typo in that
environment variable is therefore a total outage that nothing detects.

THE CONTROL FOR IT IS STATIC, in `scripts/check-docs-drift.mjs`: the name the chart sets is
asserted to be declared by a migration. A runtime probe cannot help -- by the time one could run,
the outage has already started.

=================================================================================================
SELF-SEEDED, NOT THE DEMO PERSONAS. CI's RLS job applies the migrations and deliberately not
seed.sql, so `admin@acs-cymru.local` does not exist there -- a suite depending on it passes locally
and fails in CI with a failure that looks like the policy and is actually the fixture. Same
approach, and the same teardown obligation, as test_system_settings_rls.py.
"""

import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone

import psycopg2
import psycopg2.extras

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN_ID = "7e40c8ed-0074-4000-8000-00000000ad11"
MANAGER_ID = "7e40c8ed-0074-4000-8000-00000000009f"
# The identity tokens are minted FOR. A service principal, because
# record_service_token_issued() refuses a human account outright.
SUBJECT_ID = "7e40c8ed-0074-4000-8000-0000000000fe"

FIXTURE_IDS = (ADMIN_ID, MANAGER_ID, SUBJECT_ID)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def ensure_auth_user(cur, user_id, label, with_email=False):
    """
    Make `user_id` exist in `auth.users`. Same helper, same reasoning, as the other RLS suites:
    `log_digital_thread_event()` writes `changed_by = auth.uid()` under a foreign key to
    `auth.users`, so a fixture that fakes a session without an account fails on the AUDIT insert.

    THE SUBJECT NEEDS IT FOR A SECOND REASON HERE. record_service_token_issued() reads
    `auth.users` to prove the principal cannot sign in, and refuses outright if the row is absent.

    `with_email` IS WHAT MAKES A ROW LOOK LIKE A PERSON, and it is now load-bearing in BOTH
    directions -- the same split test_service_principal_revocation.py already draws. A row carrying
    only an id satisfies is_machine_principal(), so:

        the two HUMAN fixtures need an email, or 0080's trigger on `user_roles` refuses them the
        role this suite hands them a line later;

        the SUBJECT must NOT have one, or record_service_token_issued() refuses to mint for it --
        "can sign in, so it is a person's account and not a service principal".

    One helper, two shapes, and the caller says which fixture it is seeding.
    """
    shapes = (
        ("(instance_id, id, aud, role, email)",
         ("00000000-0000-0000-0000-000000000000", user_id, "authenticated",
          "authenticated", f"{user_id}@{label}.test")),
    ) if with_email else (
        ("(id)", (user_id,)),
    )
    for columns, values in shapes:
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
        f"could not create auth.users row {user_id}; digital_thread.changed_by is an FK to it, "
        "so the tests that act as this user cannot run"
    )


def drop_fixture_principals(user_ids):
    """
    Remove what setUpClass committed. See test_system_settings_rls.py for the long form: the
    fixture has to be committed so the tests' own connections can see it, and a suite that commits
    and never cleans up leaves permanent machine identities on the Access Control page.
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


def as_user(cur, user_id):
    """Become `authenticated` with a JWT subject, the way PostgREST does it: claims only."""
    cur.execute("SET LOCAL ROLE authenticated;")
    cur.execute('SET LOCAL "request.jwt.claims" = %s;', ('{"sub": "%s"}' % user_id,))


def with_claims(cur, claims_json):
    """
    Set the raw claims GUC, WITHOUT changing role.

    `auth_pre_request()` is SECURITY DEFINER and reads nothing but this GUC, so the role is not
    what is under test here -- the claim shape is. Keeping the session as `postgres` also means a
    failure names the function rather than an unrelated RLS refusal.
    """
    cur.execute('SET LOCAL "request.jwt.claims" = %s;', (claims_json,))


class ServiceTokenRevocation(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                for needed in ("public.revoked_service_tokens",):
                    cur.execute("SELECT to_regclass(%s);", (needed,))
                    if cur.fetchone()[0] is None:
                        raise RuntimeError(f"{needed} does not exist -- run 0074 first.")

                cur.execute("SELECT id, name FROM public.roles WHERE name IN %s;",
                            (("Administrator", "Shopfloor_Manager"),))
                cls.role_id = {name: rid for rid, name in cur.fetchall()}
                for needed in ("Administrator", "Shopfloor_Manager"):
                    if needed not in cls.role_id:
                        raise RuntimeError(f"role {needed!r} is missing; 0001 did not run cleanly.")

                # THE SUBJECT IS SEEDED AS A MACHINE AND THE OTHER TWO AS PEOPLE. See the helper:
                # the two roles assigned immediately below would be refused for a machine, and the
                # mint below that would be refused for a person.
                for user_id in FIXTURE_IDS:
                    ensure_auth_user(cur, user_id, "revocation",
                                     with_email=(user_id != SUBJECT_ID))

                cur.execute(
                    "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s), (%s, %s)"
                    " ON CONFLICT (user_id, role_id) DO NOTHING;",
                    (ADMIN_ID, cls.role_id["Administrator"],
                     MANAGER_ID, cls.role_id["Shopfloor_Manager"]),
                )
                conn.commit()
        finally:
            conn.close()

    @classmethod
    def tearDownClass(cls):
        drop_fixture_principals(FIXTURE_IDS)

    def setUp(self):
        self.conn = get_connection()

    def tearDown(self):
        # Every test is a transaction that is thrown away, so no denylist row and no audit row
        # written below survives into the running stack this suite is pointed at.
        self.conn.rollback()
        self.conn.close()

    # -- helpers ---------------------------------------------------------------------------------

    def _assert_serves(self, cur):
        """
        The request proceeds -- which for this function means it RETURNED rather than raised.

        ASSERTING THE RETURN VALUE WOULD BE ASSERTING A DRIVER QUIRK: `RETURNS void` arrives as an
        empty string through psycopg2, not as None, and a test written against that is testing the
        adapter rather than the control. Not raising is the entire contract here.
        """
        try:
            cur.execute("SELECT public.auth_pre_request();")
        except psycopg2.Error as err:
            self.fail(f"auth_pre_request() refused a request it must serve: {err}")

    def _mint(self, cur, jti=None, ttl_days=30):
        """Record a TOKEN_MINTED row the way mint-mcp-token.mjs does, and return its jti."""
        jti = jti or str(uuid.uuid4())
        expires = datetime.now(timezone.utc) + timedelta(days=ttl_days)
        cur.execute(
            "SELECT public.record_service_token_issued(%s::uuid, %s, %s, '{}'::jsonb);",
            (SUBJECT_ID, jti, expires),
        )
        return jti, expires

    # ================================================================================================
    # THE FAIL-OPEN CASES. These come first because a false refusal here is a total API outage.
    # ================================================================================================

    def test_no_claims_at_all_is_served(self):
        """
        THE UNAUTHENTICATED REQUEST, which is the majority of what reaches a public API.

        `current_setting('request.jwt.claims', true)` returns NULL when the GUC was never set --
        the `true` argument is what makes that a NULL rather than an exception, and dropping it is
        the single easiest way to turn this function into an outage.
        """
        with self.conn.cursor() as cur:
            self._assert_serves(cur)

    def test_a_token_with_no_jti_is_served(self):
        """
        EVERY HUMAN SESSION IS IN THIS BRANCH, and so are the anon and service_role keys.

        GoTrue's access tokens carry no `jti`, so if an absent one were treated as suspicious the
        entire dashboard would stop working while the denylist sat empty. This is the case roadmap
        item 3 names second, and it is the one most likely to be got wrong by a stricter reading of
        "refuse what you cannot identify".
        """
        with self.conn.cursor() as cur:
            with_claims(cur, '{"sub": "%s", "role": "authenticated"}' % ADMIN_ID)
            self._assert_serves(cur)

    def test_an_empty_denylist_serves_a_token_that_has_one(self):
        """
        THE EMPTY DENYLIST, which is the state of every stack that has never revoked anything --
        i.e. all of them, until the day this matters. The retired revocable-tokens roadmap item names it first.
        """
        with self.conn.cursor() as cur:
            cur.execute("DELETE FROM public.revoked_service_tokens;")
            with_claims(cur, '{"sub": "%s", "jti": "%s"}' % (SUBJECT_ID, uuid.uuid4()))
            self._assert_serves(cur)

    def test_unparseable_claims_are_served(self):
        """
        NOT AN ATTACK THIS CAN ANSWER. PostgREST validated the signature before setting this GUC,
        so malformed JSON in it is a PostgREST-side surprise -- and raising would take the API down
        over a condition that has nothing to do with revocation.
        """
        with self.conn.cursor() as cur:
            with_claims(cur, 'this is not json')
            self._assert_serves(cur)

    def test_a_revoked_token_past_its_expiry_is_served(self):
        """
        BELT AND BRACES, asserted so it stays that way. Pruning should mean no expired row is ever
        present, and the signature check refuses the token anyway -- so this only matters if both
        fail at once, which is when a false positive would be hardest to diagnose.
        """
        with self.conn.cursor() as cur:
            jti = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at)"
                " VALUES (%s, %s::uuid, now() - interval '1 day');",
                (jti, SUBJECT_ID),
            )
            with_claims(cur, '{"sub": "%s", "jti": "%s"}' % (SUBJECT_ID, jti))
            self._assert_serves(cur)

    # ================================================================================================
    # THE CONTROL ITSELF
    # ================================================================================================

    def test_a_revoked_token_is_refused(self):
        """The whole point: a jti on the denylist aborts the request before it reaches a policy."""
        with self.conn.cursor() as cur:
            jti = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at)"
                " VALUES (%s, %s::uuid, now() + interval '30 days');",
                (jti, SUBJECT_ID),
            )
            with_claims(cur, '{"sub": "%s", "jti": "%s"}' % (SUBJECT_ID, jti))
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as caught:
                cur.execute("SELECT public.auth_pre_request();")
            # The jti is named, because it is the detail that turns "my integration broke" into
            # "this specific credential was withdrawn" -- and the holder already has it.
            self.assertIn(jti, str(caught.exception))

    def test_it_is_executable_by_every_role_postgrest_switches_to(self):
        """
        A MISSING GRANT IS AN OUTAGE FOR ONE ROLE, which is the kind of partial failure that gets
        diagnosed as anything but this function. anon is the one that would bite first and be
        blamed last.
        """
        with self.conn.cursor() as cur:
            for role in ("anon", "authenticated", "service_role"):
                cur.execute(
                    "SELECT has_function_privilege(%s, 'public.auth_pre_request()', 'EXECUTE');",
                    (role,),
                )
                self.assertTrue(cur.fetchone()[0], f"{role} cannot execute auth_pre_request()")

    # ================================================================================================
    # THE ACT
    # ================================================================================================

    def test_an_administrator_can_revoke_a_minted_token(self):
        with self.conn.cursor() as cur:
            jti, expires = self._mint(cur)
            as_user(cur, ADMIN_ID)
            cur.execute("SELECT public.revoke_service_token(%s);", (jti,))
            self.assertIsNotNone(cur.fetchone()[0])

            cur.execute("RESET ROLE;")
            cur.execute(
                "SELECT principal_id, expires_at, revoked_by FROM public.revoked_service_tokens"
                " WHERE jti = %s;", (jti,)
            )
            row = cur.fetchone()
            self.assertEqual(str(row[0]), SUBJECT_ID)
            self.assertEqual(str(row[2]), ADMIN_ID)

    def test_a_manager_cannot_revoke(self):
        """
        Administrator alone -- the sixth policy in the direction the retired revocable-tokens roadmap item describes.
        Withdrawing a credential is an access-control act, not an operational one.
        """
        with self.conn.cursor() as cur:
            jti, _ = self._mint(cur)
            as_user(cur, MANAGER_ID)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("SELECT public.revoke_service_token(%s);", (jti,))

    def test_a_jti_nobody_minted_is_refused(self):
        """
        WHAT STOPS THE DENYLIST FILLING WITH NOISE. A caller cannot revoke a token this stack has
        no record of issuing -- and if such a token exists, the missing record is the more urgent
        problem than the revocation.
        """
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            with self.assertRaises(psycopg2.errors.ForeignKeyViolation):
                cur.execute("SELECT public.revoke_service_token(%s);", (str(uuid.uuid4()),))

    def test_an_already_expired_token_is_refused_as_a_no_op(self):
        """
        Told rather than accepted quietly: the signature check already refuses it, so a row would
        be pruned on its way in and the operator would be assured a credential was withdrawn when
        nothing changed.
        """
        with self.conn.cursor() as cur:
            jti = str(uuid.uuid4())
            # Recorded directly: record_service_token_issued() refuses a past expiry, which is its
            # job, so the row this needs cannot be made through the front door.
            cur.execute(
                "INSERT INTO public.digital_thread"
                " (entity_type, entity_id, action, new_data, actor_source, audit_domain)"
                " VALUES ('service_principals', %s::uuid, 'TOKEN_MINTED',"
                "         jsonb_build_object('jti', %s, 'expires_at', now() - interval '1 day'),"
                "         'service', 'security');",
                (SUBJECT_ID, jti),
            )
            as_user(cur, ADMIN_ID)
            with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                cur.execute("SELECT public.revoke_service_token(%s);", (jti,))

    def test_revoking_twice_is_not_an_error(self):
        """
        An operator will do this -- the button sits in a page that refreshes -- and the second
        press should confirm rather than fail.
        """
        with self.conn.cursor() as cur:
            jti, _ = self._mint(cur)
            as_user(cur, ADMIN_ID)
            cur.execute("SELECT public.revoke_service_token(%s);", (jti,))
            cur.execute("SELECT public.revoke_service_token(%s);", (jti,))
            cur.execute("RESET ROLE;")
            cur.execute("SELECT count(*) FROM public.revoked_service_tokens WHERE jti = %s;", (jti,))
            self.assertEqual(cur.fetchone()[0], 1)

    def test_revocation_prunes_expired_rows(self):
        """
        SELF-PRUNING IS WHAT BOUNDS THE TABLE, and the lookup this adds to every request with it.
        Done on the write path because that is the only time the table is touched at all.
        """
        with self.conn.cursor() as cur:
            dead = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at)"
                " VALUES (%s, %s::uuid, now() - interval '1 day');",
                (dead, SUBJECT_ID),
            )
            jti, _ = self._mint(cur)
            as_user(cur, ADMIN_ID)
            cur.execute("SELECT public.revoke_service_token(%s);", (jti,))
            cur.execute("RESET ROLE;")
            cur.execute("SELECT count(*) FROM public.revoked_service_tokens WHERE jti = %s;", (dead,))
            self.assertEqual(cur.fetchone()[0], 0)

    def test_it_writes_a_token_revoked_row_in_the_security_lane(self):
        """
        `audit_domain_for()` files everything on `service_principals` under `security` already, so
        this needed no change there -- which is worth asserting rather than assuming, because the
        row landing in the asset lane would put a credential withdrawal in front of every
        Shopfloor_Manager.
        """
        with self.conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            jti, _ = self._mint(cur)
            as_user(cur, ADMIN_ID)
            cur.execute("SELECT public.revoke_service_token(%s);", (jti,))
            cur.execute("RESET ROLE;")
            cur.execute(
                "SELECT action, audit_domain, changed_by, actor_source, new_data, old_data"
                " FROM public.digital_thread WHERE action = 'TOKEN_REVOKED'"
                "   AND new_data ->> 'jti' = %s;", (jti,)
            )
            row = cur.fetchone()
            self.assertIsNotNone(row, "no TOKEN_REVOKED row was written")
            self.assertEqual(row["audit_domain"], "security")
            self.assertEqual(str(row["changed_by"]), ADMIN_ID)
            self.assertEqual(row["actor_source"], "user")
            # The scope is on the row because four services never consult the denylist. A row
            # claiming a revocation without saying where would overstate what happened.
            self.assertEqual(row["new_data"]["scope"], "postgrest")
            # The mint row is carried in old_data so this is readable once the denylist entry has
            # been pruned -- which happens the moment the token expires.
            self.assertEqual(row["old_data"]["jti"], jti)

    def test_the_denylist_is_not_readable_by_a_manager(self):
        """
        Read is Administrator and Auditor, matching the `security` lane these events file under.
        A Shopfloor_Manager reading it would learn which credentials exist and when they lapse.
        """
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at)"
                " VALUES (%s, %s::uuid, now() + interval '30 days');",
                (str(uuid.uuid4()), SUBJECT_ID),
            )
            as_user(cur, MANAGER_ID)
            cur.execute("SELECT count(*) FROM public.revoked_service_tokens;")
            self.assertEqual(cur.fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
