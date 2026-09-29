"""
0076 -- revoking a whole service PRINCIPAL, rather than one of its tokens.

=================================================================================================
THE TEST THAT MATTERS MOST IS THAT THE FLAG DOES SOMETHING.

0043 rejected deleting the `auth.users` row because the signature is validated and the subject is
never looked up -- the token keeps working against a principal that no longer exists. A flag has
exactly the same failure available to it, and a flag nothing reads would ship a control that reads
as safety while every outstanding token carried on working. So the first assertions here are that
`auth_pre_request()` refuses a token naming a revoked principal, including one minted AFTER the
revocation and one this stack holds no record of.

The fail-open cases from test_service_token_revocation.py still apply and are re-asserted for the
new arm: a `sub` that is not a uuid must be SERVED, not raised on, or one junk token presented by
one caller becomes a total outage for everybody.
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

ADMIN_ID = "9e70c8ed-0076-4000-8000-00000000ad11"
MANAGER_ID = "9e70c8ed-0076-4000-8000-00000000009f"
SUBJECT_ID = "9e70c8ed-0076-4000-8000-0000000000fe"

FIXTURE_IDS = (ADMIN_ID, MANAGER_ID, SUBJECT_ID)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def ensure_auth_user(cur, user_id, label, with_email=False):
    """
    Make `user_id` exist in `auth.users`.

    `with_email` IS WHAT MAKES A ROW LOOK LIKE A PERSON. is_machine_principal() tests for no email
    AND no password AND no identity row, so the human-account refusal below needs a fixture that
    fails that predicate -- and the two-shape fallback here is otherwise the same helper the other
    RLS suites use.
    """
    shapes = (
        ("(instance_id, id, aud, role, email, encrypted_password)",
         ("00000000-0000-0000-0000-000000000000", user_id, "authenticated",
          "authenticated", f"{user_id}@{label}.test", "not-a-real-hash")),
    ) if with_email else (
        # THE ID-ONLY SHAPE IS THE POINT HERE, not a fallback. This arm seeds the SUBJECT -- the
        # machine principal the suite revokes -- and it has to fail is_machine_principal()'s
        # negation, i.e. it must genuinely be a machine. Do not add an email to it: the emailed
        # shape belongs to the `with_email` arm above, which is what the human fixtures take.
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
    raise RuntimeError(f"could not create auth.users row {user_id}")


def drop_fixture_principals(user_ids):
    """Remove what setUpClass committed. See test_system_settings_rls.py for the long form."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM public.user_roles WHERE user_id = ANY(%s);",
                        ([str(u) for u in user_ids],))
            cur.execute("DELETE FROM public.revoked_service_principals WHERE principal_id = ANY(%s::uuid[]);",
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
    cur.execute("SET LOCAL ROLE authenticated;")
    cur.execute('SET LOCAL "request.jwt.claims" = %s;', ('{"sub": "%s"}' % user_id,))


def with_claims(cur, claims_json):
    cur.execute('SET LOCAL "request.jwt.claims" = %s;', (claims_json,))


class ServicePrincipalRevocation(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regclass('public.revoked_service_principals');")
                if cur.fetchone()[0] is None:
                    raise RuntimeError("public.revoked_service_principals does not exist -- run 0076.")

                cur.execute("SELECT id, name FROM public.roles WHERE name IN %s;",
                            (("Administrator", "Shopfloor_Manager"),))
                cls.role_id = {name: rid for rid, name in cur.fetchall()}

                # The two actors look like people; the SUBJECT must look like a machine or
                # is_machine_principal() refuses to revoke it.
                ensure_auth_user(cur, ADMIN_ID, "principalrevoke", with_email=True)
                ensure_auth_user(cur, MANAGER_ID, "principalrevoke", with_email=True)
                ensure_auth_user(cur, SUBJECT_ID, "principalrevoke")

                cur.execute(
                    "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s), (%s, %s)"
                    " ON CONFLICT (user_id, role_id) DO NOTHING;",
                    (ADMIN_ID, cls.role_id["Administrator"],
                     MANAGER_ID, cls.role_id["Shopfloor_Manager"]),
                )
                conn.commit()

                cur.execute("SELECT public.is_machine_principal(%s::uuid);", (SUBJECT_ID,))
                if not cur.fetchone()[0]:
                    raise RuntimeError("the subject fixture is not a machine principal")
        finally:
            conn.close()

    @classmethod
    def tearDownClass(cls):
        drop_fixture_principals(FIXTURE_IDS)

    def setUp(self):
        self.conn = get_connection()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def _revoke(self, cur, reason="decommissioned"):
        as_user(cur, ADMIN_ID)
        cur.execute("SELECT public.revoke_service_principal(%s::uuid, %s);", (SUBJECT_ID, reason))
        row = cur.fetchone()[0]
        cur.execute("RESET ROLE;")
        return row

    def _mint(self, cur, ttl_days=30):
        jti = str(uuid.uuid4())
        expires = datetime.now(timezone.utc) + timedelta(days=ttl_days)
        cur.execute("SELECT public.record_service_token_issued(%s::uuid, %s, %s);",
                    (SUBJECT_ID, jti, expires))
        return jti

    # ================================================================================================
    # THE FLAG HAS TO DO SOMETHING
    # ================================================================================================

    def test_a_token_naming_a_revoked_principal_is_refused(self):
        """
        THE WHOLE POINT. Deleting the auth.users row does nothing because the subject is never
        looked up; a flag nothing reads would fail the same way. This is the assertion that says
        auth_pre_request() actually consults it.
        """
        with self.conn.cursor() as cur:
            self._revoke(cur)
            with_claims(cur, '{"sub": "%s", "jti": "%s"}' % (SUBJECT_ID, uuid.uuid4()))
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as caught:
                cur.execute("SELECT public.auth_pre_request();")
            self.assertIn("identity has been revoked", str(caught.exception))

    def test_it_refuses_a_token_with_no_jti_at_all(self):
        """
        THE ARM THE TOKEN DENYLIST CANNOT REACH, and the reason principal revocation is worth
        having rather than looping over the known tokens. A credential this stack holds no
        TOKEN_MINTED row for -- signed before the recorder existed, or by something off-book --
        carries a `sub` all the same.
        """
        with self.conn.cursor() as cur:
            self._revoke(cur)
            with_claims(cur, '{"sub": "%s"}' % SUBJECT_ID)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("SELECT public.auth_pre_request();")

    def test_another_principal_is_unaffected(self):
        """A denylist that refused everybody would pass the test above and be an outage."""
        with self.conn.cursor() as cur:
            self._revoke(cur)
            with_claims(cur, '{"sub": "%s", "jti": "%s"}' % (uuid.uuid4(), uuid.uuid4()))
            try:
                cur.execute("SELECT public.auth_pre_request();")
            except psycopg2.Error as err:
                self.fail(f"an unrelated principal was refused: {err}")

    def test_a_sub_that_is_not_a_uuid_is_served(self):
        """
        FAIL-OPEN, AND THE CAST IS WHY THIS EXISTS. `sub` is whatever the JWT carried. A bare
        `v_sub::uuid` would raise on `sub: "hello"` -- turning one junk token presented by one
        caller into a refusal of EVERY request through this hook.
        """
        with self.conn.cursor() as cur:
            with_claims(cur, '{"sub": "hello"}')
            try:
                cur.execute("SELECT public.auth_pre_request();")
            except psycopg2.Error as err:
                self.fail(f"a malformed sub took the API down: {err}")

    def test_a_malformed_sub_does_not_let_a_revoked_token_through(self):
        """
        THE TRAP THE ARM ORDER CREATED. The subject arm is checked first so its message wins, and
        its cast is guarded against a `sub` that is not a uuid. If that guard RETURNED instead of
        falling through, a token could carry a revoked jti and a junk `sub` and skip the token
        denylist entirely -- a bypass usable by anyone who can present a JWT.
        """
        with self.conn.cursor() as cur:
            jti = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at)"
                " VALUES (%s, %s::uuid, now() + interval '30 days');", (jti, SUBJECT_ID))
            with_claims(cur, '{"sub": "not-a-uuid", "jti": "%s"}' % jti)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as caught:
                cur.execute("SELECT public.auth_pre_request();")
            self.assertIn("token has been revoked", str(caught.exception))

    def test_a_revoked_principal_reports_the_identity_not_the_token(self):
        """
        Revoking a principal cascades to its tokens, so after one BOTH arms match. The subject arm
        is checked first because "this identity has been revoked" explains the mint refusal that
        follows, where "this token has been revoked" invites a replacement request that will fail.
        """
        with self.conn.cursor() as cur:
            jti = self._mint(cur)
            self._revoke(cur)
            with_claims(cur, '{"sub": "%s", "jti": "%s"}' % (SUBJECT_ID, jti))
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as caught:
                cur.execute("SELECT public.auth_pre_request();")
            self.assertIn("identity has been revoked", str(caught.exception))

    def test_the_token_arm_still_works(self):
        """0076 rewrote auth_pre_request(); 0074's behaviour must survive that rewrite."""
        with self.conn.cursor() as cur:
            jti = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at)"
                " VALUES (%s, %s::uuid, now() + interval '30 days');", (jti, SUBJECT_ID))
            with_claims(cur, '{"sub": "%s", "jti": "%s"}' % (uuid.uuid4(), jti))
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as caught:
                cur.execute("SELECT public.auth_pre_request();")
            self.assertIn("token has been revoked", str(caught.exception))

    def test_no_claims_is_still_served(self):
        with self.conn.cursor() as cur:
            try:
                cur.execute("SELECT public.auth_pre_request();")
            except psycopg2.Error as err:
                self.fail(f"an unauthenticated request was refused: {err}")

    # ================================================================================================
    # THE ACT
    # ================================================================================================

    def test_it_revokes_the_outstanding_tokens_too(self):
        """
        Redundant for PostgREST -- the subject arm already refuses them -- and not redundant for
        the audit trail or for reinstatement, which is the whole reason reinstatement is safe.
        """
        with self.conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            live = self._mint(cur, ttl_days=30)
            self._revoke(cur)

            cur.execute("SELECT count(*) FROM public.revoked_service_tokens WHERE jti = %s;", (live,))
            self.assertEqual(cur.fetchone()[0], 1, "the outstanding token was not withdrawn")

            cur.execute(
                "SELECT new_data FROM public.audit_trail WHERE action = 'TOKEN_REVOKED'"
                "   AND new_data ->> 'jti' = %s;", (live,))
            self.assertEqual(cur.fetchone()["new_data"]["cascaded_from"], "PRINCIPAL_REVOKED")

    def test_it_writes_a_principal_revoked_row_in_the_security_lane(self):
        with self.conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            self._mint(cur)
            self._revoke(cur, reason="left the project")

            cur.execute(
                "SELECT audit_domain, changed_by, actor_source, new_data FROM public.audit_trail"
                " WHERE action = 'PRINCIPAL_REVOKED' AND entity_id = %s::uuid;", (SUBJECT_ID,))
            row = cur.fetchone()
            self.assertEqual(row["audit_domain"], "security")
            self.assertEqual(str(row["changed_by"]), ADMIN_ID)
            self.assertEqual(row["actor_source"], "user")
            self.assertEqual(row["new_data"]["reason"], "left the project")
            self.assertEqual(row["new_data"]["tokens_revoked"], 1)

    def test_a_manager_cannot_revoke(self):
        with self.conn.cursor() as cur:
            as_user(cur, MANAGER_ID)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("SELECT public.revoke_service_principal(%s::uuid, NULL);", (SUBJECT_ID,))

    def test_a_human_account_is_refused(self):
        """
        THE SAFETY PROPERTY. `sub` is on every JWT, so a row naming a person would lock them out of
        PostgREST through a control built for machines -- and out of the request that would undo it.
        """
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                cur.execute("SELECT public.revoke_service_principal(%s::uuid, NULL);", (MANAGER_ID,))

    def test_revoking_twice_is_refused_rather_than_silently_ignored(self):
        """
        Unlike a token, where a second press should confirm. Here a silent success would overwrite
        nothing and leave the operator believing a NEW reason had been recorded.
        """
        with self.conn.cursor() as cur:
            self._revoke(cur)
            as_user(cur, ADMIN_ID)
            with self.assertRaises(psycopg2.errors.UniqueViolation):
                cur.execute("SELECT public.revoke_service_principal(%s::uuid, NULL);", (SUBJECT_ID,))

    # ================================================================================================
    # PUTTING IT BACK
    # ================================================================================================

    def test_reinstating_lifts_the_refusal(self):
        with self.conn.cursor() as cur:
            self._revoke(cur)
            as_user(cur, ADMIN_ID)
            cur.execute("SELECT public.reinstate_service_principal(%s::uuid);", (SUBJECT_ID,))
            cur.execute("RESET ROLE;")

            with_claims(cur, '{"sub": "%s"}' % SUBJECT_ID)
            try:
                cur.execute("SELECT public.auth_pre_request();")
            except psycopg2.Error as err:
                self.fail(f"a reinstated principal is still refused: {err}")

    def test_reinstating_does_not_restore_the_tokens(self):
        """
        THE PROPERTY THAT MAKES REINSTATEMENT SAFE TO OFFER AT ALL. An operator putting an identity
        back is restoring the IDENTITY, not handing back whatever credentials were live when it was
        withdrawn -- and revoke_service_token() has no inverse, so those stay refused.
        """
        with self.conn.cursor() as cur:
            live = self._mint(cur)
            self._revoke(cur)
            as_user(cur, ADMIN_ID)
            cur.execute("SELECT public.reinstate_service_principal(%s::uuid);", (SUBJECT_ID,))
            cur.execute("RESET ROLE;")

            with_claims(cur, '{"sub": "%s", "jti": "%s"}' % (SUBJECT_ID, live))
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as caught:
                cur.execute("SELECT public.auth_pre_request();")
            self.assertIn("token has been revoked", str(caught.exception))

    def test_reinstating_something_not_revoked_is_refused(self):
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                cur.execute("SELECT public.reinstate_service_principal(%s::uuid);", (SUBJECT_ID,))

    def test_a_manager_cannot_reinstate(self):
        with self.conn.cursor() as cur:
            self._revoke(cur)
            as_user(cur, MANAGER_ID)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute("SELECT public.reinstate_service_principal(%s::uuid);", (SUBJECT_ID,))

    # ================================================================================================
    # THE MINT REFUSES A REVOKED PRINCIPAL
    # ================================================================================================

    def test_a_revoked_principal_cannot_be_issued_a_new_token(self):
        """
        Without this the page signs a credential, records it, reveals it once, and has it refused
        on its first request -- with the operator having followed the page to get there.
        """
        with self.conn.cursor() as cur:
            self._revoke(cur)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege) as caught:
                self._mint(cur)
            self.assertIn("has been revoked", str(caught.exception))

    def test_the_denylist_is_not_readable_by_a_manager(self):
        with self.conn.cursor() as cur:
            self._revoke(cur)
            as_user(cur, MANAGER_ID)
            cur.execute("SELECT count(*) FROM public.revoked_service_principals;")
            self.assertEqual(cur.fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
