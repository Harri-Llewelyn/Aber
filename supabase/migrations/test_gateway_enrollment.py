"""
Integration tests for 0025_physical_gateway_enrollment.sql.

WHAT THESE TESTS ARE FOR. Every property asserted here fails SILENTLY and in the dangerous
direction if it regresses:

  * a token table readable by `authenticated` never errors -- it just exposes the claim material
    for every Remote gateway to every signed-in user, including Operator and Auditor;
  * a non-atomic claim never errors -- two appliances redeem one token, both receive a credential
    for the same edge node, and because the broker's roles pin the topic to the username they then
    fight over one identity with no message anywhere saying so;
  * a token that outlives its expiry never errors -- the bundle in somebody's downloads folder just
    keeps working;
  * a migration that is not idempotent fails only on the SECOND boot: the first upgrade after the
    database claim already exists.

So the suite exercises the deployed SQL rather than reasoning about it: it runs as `authenticated`
with simulated JWT claims, exactly as the RLS policies and public.has_role() see a real caller.

Run against a stack with the migrations applied:
    python -m unittest supabase.migrations.test_gateway_enrollment -v
"""
import os
import unittest

import psycopg2
from psycopg2 import errors as pg_errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))


# Pinned so a failed run leaves rows that the next setUpClass reclaims rather than accumulating.
# The 2f/2e prefixes cannot collide with the simulator (12-15…) or validator (11…) blocks, and
# they differ in the FIRST group because sparkplug_id is GENERATED from the leading 21 hex
# characters (0001): ids differing only in a later group collide on the generated column.
REMOTE_GW = "2f000000-0000-4000-8000-000000000001"
HOST_GW = "2e000000-0000-4000-8000-000000000001"

# THE DEMO ACCOUNTS FROM supabase/seed.sql, NOT SYNTHETIC UUIDs, and that is not a convenience.
#
# `audit_trail.changed_by` carries a FOREIGN KEY to auth.users, and `gateways` fires
# log_audit_trail_event() on every write -- so issuing a token (which moves the gateway to
# PENDING_ENROLLMENT) writes an audit row attributed to auth.uid(). An invented user id therefore
# fails the whole call with a foreign-key violation raised from inside the audit trigger, several
# frames away from anything the test is about.
#
# Using the seeded accounts makes the fixture faithful as well as working: these are the identities
# a real caller actually presents, one per role.
ADMIN_USER = "a0000000-0000-0000-0000-000000000001"
MANAGER_USER = "a0000000-0000-0000-0000-000000000002"
OPERATOR_USER = "a0000000-0000-0000-0000-000000000003"
AUDITOR_USER = "a0000000-0000-0000-0000-000000000004"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def as_role(cur, user_id, role_name):
    """
    Become `authenticated` with the JWT claims a real caller presents.

    public.has_role() resolves auth.uid() against public.user_roles, so the `sub` claim is what
    actually decides authority -- app_metadata.role is set too because it is what a real GoTrue
    token carries, and a test that omitted it would not be exercising the same input.
    """
    cur.execute("SET ROLE authenticated;")
    cur.execute(
        "SELECT set_config('request.jwt.claims', %s, true);",
        ('{"sub": "%s", "role": "authenticated", "app_metadata": {"role": "%s"}}'
         % (user_id, role_name),),
    )


# WHETHER A MISSING PREREQUISITE IS A SKIP OR A FAILURE, and the answer depends on who is running.
#
# Skipping is right at a developer's terminal: a stack brought up without seed.sql cannot support
# these assertions, and refusing to run is more honest than failing on an absence the developer
# already knows about.
#
# It is WRONG IN CI, and quietly so. `unittest` reports a fully-skipped run as `OK (skipped=6)` and
# exits 0, so a job that lost its seed data would go green while asserting NOTHING -- and this is
# the suite covering the enrolment-token secrecy boundary, where "nothing was checked" and "nothing
# is wrong" look identical from the outside. That is worse than not running the suite at all,
# because it reads as coverage.
#
# So the caller declares which situation it is in. CI's end-to-end job sets this, because there the
# seed is guaranteed and its absence is a real fault.
STRICT = os.getenv("REQUIRE_SEEDED_ACCOUNTS", "").lower() in ("1", "true", "yes")


def _absent(reason):
    """Raise the right kind of stop for the caller: a failure under STRICT, otherwise a skip."""
    if STRICT:
        raise AssertionError(
            f"{reason}\n\n"
            "REQUIRE_SEEDED_ACCOUNTS is set, so this is a failure rather than a skip: "
            "the caller has declared that the seeded stack is expected to be present."
        )
    raise unittest.SkipTest(reason)


class GatewayEnrollmentBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute("SELECT to_regclass('public.gateway_enrollment_tokens');")
            if not cur.fetchone()[0]:
                _absent(
                    "public.gateway_enrollment_tokens does not exist -- apply "
                    "0025_physical_gateway_enrollment.sql first"
                )

            # The four seeded accounts must exist and hold one role each -- every authority
            # assertion below is meaningless without them, and a stack brought up without
            # supabase/seed.sql would otherwise report those tests as passing.
            cur.execute(
                """
                SELECT r.name FROM public.user_roles ur
                  JOIN public.roles r ON r.id = ur.role_id
                 WHERE ur.user_id IN (%s, %s, %s, %s);
                """,
                (ADMIN_USER, MANAGER_USER, OPERATOR_USER, AUDITOR_USER),
            )
            found = sorted(r[0] for r in cur.fetchall())
            if found != ["Administrator", "Auditor", "Operator", "Shopfloor_Manager"]:
                _absent(
                    "the seeded demo accounts are absent or their roles differ "
                    f"(found {found}) -- apply supabase/seed.sql first"
                )

            # A REMOTE gateway and a HOST one, because the issuing RPC refuses the second and
            # that refusal is a property worth holding onto: a bundle for a host-run gateway would
            # mint a broker credential nothing could ever present.
            cur.execute(
                """
                INSERT INTO public.gateways (id, name, status, deployment)
                VALUES (%s, 'Test_Remote_Gateway',   'OFFLINE', 'remote'),
                       (%s, 'Test_Host_Run_Gateway', 'OFFLINE', 'host')
                ON CONFLICT (id) DO UPDATE
                   SET deployment = EXCLUDED.deployment, status = 'OFFLINE';
                """,
                (REMOTE_GW, HOST_GW),
            )
            conn.commit()
        finally:
            conn.close()

    @classmethod
    def tearDownClass(cls):
        conn = get_connection()
        cur = conn.cursor()
        try:
            # The tokens go with the gateway: the FK is ON DELETE CASCADE. The demo accounts are
            # NOT removed -- they are the stack's own seed data, not this suite's fixture.
            cur.execute("DELETE FROM public.gateways WHERE id IN (%s, %s);", (REMOTE_GW, HOST_GW))
            conn.commit()
        finally:
            conn.close()

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()

    def tearDown(self):
        # Rollback rather than cleanup: every test's writes are undone by construction, so one
        # failing test cannot leave state that makes the next one pass or fail for the wrong reason.
        self.conn.rollback()
        self.conn.close()

    def issue(self, gateway_id=REMOTE_GW, ttl=30, user=ADMIN_USER, role="Administrator"):
        as_role(self.cur, user, role)
        self.cur.execute(
            "SELECT token, expires_at FROM public.issue_gateway_enrollment_token(%s, %s);",
            (gateway_id, ttl),
        )
        row = self.cur.fetchone()
        self.cur.execute("RESET ROLE;")
        return row


class TestTokenTableIsUnreachable(GatewayEnrollmentBase):
    """The table must not be readable or writable by any browser-facing role."""

    def test_rls_is_enabled_with_no_policies(self):
        self.cur.execute(
            "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.gateway_enrollment_tokens'::regclass;"
        )
        self.assertTrue(self.cur.fetchone()[0], "RLS is not enabled on gateway_enrollment_tokens")

        self.cur.execute(
            "SELECT count(*) FROM pg_policies "
            "WHERE schemaname = 'public' AND tablename = 'gateway_enrollment_tokens';"
        )
        self.assertEqual(
            self.cur.fetchone()[0], 0,
            "gateway_enrollment_tokens must have NO RLS policies -- it is reachable only by "
            "service_role, which bypasses RLS. A policy here would be the first grant of browser "
            "access to token material.",
        )

    def test_no_grants_to_anon_or_authenticated(self):
        # Supabase's default privileges GRANT ALL on a new table in `public` to anon and
        # authenticated, so this asserts the REVOKE actually ran rather than that it was written.
        self.cur.execute(
            """
            SELECT DISTINCT grantee FROM information_schema.role_table_grants
             WHERE table_schema = 'public' AND table_name = 'gateway_enrollment_tokens'
               AND grantee IN ('anon', 'authenticated', 'PUBLIC');
            """
        )
        self.assertEqual([r[0] for r in self.cur.fetchall()], [])

    def test_privileged_user_still_cannot_select_tokens(self):
        """Even an Administrator. Authority over gateways is not authority over claim material."""
        self.issue()
        for user, role in ((ADMIN_USER, "Administrator"),
                           (AUDITOR_USER, "Auditor"),
                           (OPERATOR_USER, "Operator")):
            with self.subTest(role=role):
                as_role(self.cur, user, role)
                with self.assertRaises(
                    pg_errors.InsufficientPrivilege,
                    msg=f"{role} could read gateway_enrollment_tokens",
                ):
                    self.cur.execute("SELECT token_hash FROM public.gateway_enrollment_tokens;")
                self.conn.rollback()

    def test_raw_token_is_never_stored(self):
        token, _ = self.issue()
        self.cur.execute(
            "SELECT count(*) FROM public.gateway_enrollment_tokens WHERE token_hash = %s;", (token,)
        )
        self.assertEqual(
            self.cur.fetchone()[0], 0,
            "the raw token was stored in token_hash; only its SHA-256 may be persisted",
        )
        self.cur.execute(
            "SELECT count(*) FROM public.gateway_enrollment_tokens "
            " WHERE token_hash = encode(extensions.digest(%s, 'sha256'), 'hex');",
            (token,),
        )
        self.assertEqual(self.cur.fetchone()[0], 1)


class TestIssuing(GatewayEnrollmentBase):
    def test_administrator_can_issue(self):
        token, expires_at = self.issue()
        self.assertRegex(token, r"^[0-9a-f]{64}$", "token must be 32 random bytes, hex encoded")
        self.assertIsNotNone(expires_at)

    def test_shopfloor_manager_can_issue(self):
        token, _ = self.issue(user=MANAGER_USER, role="Shopfloor_Manager")
        self.assertRegex(token, r"^[0-9a-f]{64}$")

    def test_operator_cannot_issue(self):
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self.issue(user=OPERATOR_USER, role="Operator")

    def test_auditor_cannot_issue(self):
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self.issue(user=AUDITOR_USER, role="Auditor")

    def test_anon_cannot_execute_at_all(self):
        """The EXECUTE grant, not the has_role() check -- one bug away from an open mint."""
        self.cur.execute("SET ROLE anon;")
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self.cur.execute(
                "SELECT * FROM public.issue_gateway_enrollment_token(%s, 30);", (REMOTE_GW,)
            )

    def test_a_host_gateway_is_refused(self):
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.issue(gateway_id=HOST_GW)

    def test_unknown_gateway_is_refused(self):
        with self.assertRaises(psycopg2.errors.ForeignKeyViolation):
            self.issue(gateway_id="00000000-0000-4000-8000-00000000dead")

    def test_ttl_is_bounded(self):
        for ttl in (0, -1, 1441):
            with self.subTest(ttl=ttl):
                with self.assertRaises(psycopg2.errors.InvalidParameterValue):
                    self.issue(ttl=ttl)
                self.conn.rollback()

    def test_issuing_sets_pending_enrollment(self):
        self.issue()
        self.cur.execute("SELECT status FROM public.gateways WHERE id = %s;", (REMOTE_GW,))
        self.assertEqual(self.cur.fetchone()[0], "PENDING_ENROLLMENT")

    def test_reissuing_invalidates_the_previous_token(self):
        """
        The property that makes 'regenerate bundle' safe. Without it a re-issue leaves the
        previously downloaded bundle live, so two claims exist for one gateway -- and the partial
        unique index would reject the insert anyway, turning a routine act into an error.
        """
        first, _ = self.issue()
        second, _ = self.issue()
        self.assertNotEqual(first, second)

        self.cur.execute(
            """
            SELECT count(*) FILTER (WHERE consumed_at IS NULL),
                   count(*)
              FROM public.gateway_enrollment_tokens WHERE gateway_id = %s;
            """,
            (REMOTE_GW,),
        )
        live, total = self.cur.fetchone()
        self.assertEqual(live, 1, "more than one live token exists for a single gateway")
        self.assertEqual(total, 2, "the superseded token should be retained as consumed, not deleted")

        # And the superseded one is genuinely dead.
        self.cur.execute("SELECT count(*) FROM public.consume_gateway_enrollment_token(%s);", (first,))
        self.assertEqual(self.cur.fetchone()[0], 0)


class TestRedeeming(GatewayEnrollmentBase):
    def test_valid_token_returns_the_wire_identity(self):
        token, _ = self.issue()
        self.cur.execute(
            "SELECT gateway_id, sparkplug_id, sparkplug_group, gateway_name "
            "  FROM public.consume_gateway_enrollment_token(%s);",
            (token,),
        )
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "a live token was refused")
        gateway_id, sparkplug_id, sparkplug_group, name = row
        self.assertEqual(str(gateway_id), REMOTE_GW)
        # The username the broker's roles pin the topic's edge-node segment to. An appliance given
        # anything else authenticates and then has every message dropped by the broker.
        self.assertRegex(sparkplug_id, r"^gwy[0-9a-f]{21}$")
        # The other half of the address resolve_gateway() looks up first. Omitting it leaves the
        # appliance matched by sparkplug_id alone, which ingestion accepts with a mismatch warning.
        self.assertTrue(sparkplug_group)
        self.assertEqual(name, "Test_Remote_Gateway")

    def test_token_is_single_use(self):
        token, _ = self.issue()
        self.cur.execute("SELECT count(*) FROM public.consume_gateway_enrollment_token(%s);", (token,))
        self.assertEqual(self.cur.fetchone()[0], 1)
        self.cur.execute("SELECT count(*) FROM public.consume_gateway_enrollment_token(%s);", (token,))
        self.assertEqual(self.cur.fetchone()[0], 0, "a consumed token was redeemed a second time")

    def _expire_live_token(self):
        """
        Age the gateway's live token into the past, and return its id.

        BOTH TIMESTAMPS MOVE, and they have to: `gateway_enrollment_tokens_expiry_after_creation`
        asserts `expires_at > created_at`, so backdating the expiry alone is rejected by the
        constraint rather than producing an expired token. Moving the pair reproduces the real
        state exactly -- a token issued two hours ago with a one-hour TTL.

        Ageing in place rather than sleeping: the predicate under test is a single `expires_at >
        now()` comparison, and a test that waited would be slow without asserting anything more.
        """
        self.cur.execute(
            """
            UPDATE public.gateway_enrollment_tokens
               SET created_at = now() - interval '2 hours',
                   expires_at = now() - interval '1 hour'
             WHERE gateway_id = %s AND consumed_at IS NULL
            RETURNING id;
            """,
            (REMOTE_GW,),
        )
        return self.cur.fetchone()[0]

    def test_expired_token_is_refused(self):
        token, _ = self.issue(ttl=1)
        self._expire_live_token()
        self.cur.execute("SELECT count(*) FROM public.consume_gateway_enrollment_token(%s);", (token,))
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_expired_token_is_not_consumed_by_the_attempt(self):
        """
        A REFUSED REDEMPTION MUST WRITE NOTHING. The UPDATE matches no row, so `consumed_at` stays
        NULL and the token remains merely expired.

        Worth asserting separately because a predicate reordered to claim first and validate second
        would pass every other test in this class: the redemption would still be refused, and the
        only visible difference would be a token that had silently changed state on a failed
        attempt -- which matters the moment anything reports on why a bundle did not work.
        """
        token, _ = self.issue(ttl=1)
        token_id = self._expire_live_token()

        self.cur.execute("SELECT count(*) FROM public.consume_gateway_enrollment_token(%s);", (token,))
        self.assertEqual(self.cur.fetchone()[0], 0, "an expired token was redeemed")

        self.cur.execute(
            "SELECT consumed_at FROM public.gateway_enrollment_tokens WHERE id = %s;", (token_id,)
        )
        self.assertIsNone(
            self.cur.fetchone()[0],
            "a refused redemption marked the token consumed; the claim must write nothing unless it wins",
        )

    def test_unknown_and_malformed_tokens_are_refused_identically(self):
        # All three return zero rows rather than distinguishable errors: telling them apart would
        # let an enumerator learn which token values ever existed.
        for value in ("f" * 64, "not-a-token", "", "ABCDEF" * 10 + "abcd"):
            with self.subTest(token=value[:16]):
                self.cur.execute(
                    "SELECT count(*) FROM public.consume_gateway_enrollment_token(%s);", (value,)
                )
                self.assertEqual(self.cur.fetchone()[0], 0)

    def test_null_token_is_refused(self):
        self.cur.execute("SELECT count(*) FROM public.consume_gateway_enrollment_token(NULL);")
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_a_token_can_be_checked_without_being_spent(self):
        """
        0105: the installer, the playbook and the .env are fetched against the token before the
        appliance enrols, so the check must leave the token live. Same identity as redemption
        answers, plus the expiry; then redemption still succeeds exactly once.
        """
        token, expires_at = self.issue()
        self.cur.execute(
            "SELECT gateway_id, sparkplug_id, gateway_name, expires_at "
            "  FROM public.peek_gateway_enrollment_token(%s);",
            (token,),
        )
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "a live token was refused by the check")
        self.assertEqual(str(row[0]), REMOTE_GW)
        self.assertRegex(row[1], r"^gwy[0-9a-f]{21}$")
        self.assertEqual(row[2], "Test_Remote_Gateway")
        self.assertEqual(row[3], expires_at)
        for _ in range(3):
            self.cur.execute("SELECT count(*) FROM public.peek_gateway_enrollment_token(%s);", (token,))
            self.assertEqual(self.cur.fetchone()[0], 1, "checking a token consumed it")
        self.cur.execute("SELECT count(*) FROM public.consume_gateway_enrollment_token(%s);", (token,))
        self.assertEqual(self.cur.fetchone()[0], 1)
        self.cur.execute("SELECT count(*) FROM public.peek_gateway_enrollment_token(%s);", (token,))
        self.assertEqual(self.cur.fetchone()[0], 0, "a spent token still reads as live")

    def test_the_check_refuses_what_redemption_refuses(self):
        for value in ("", "not-a-token", "0" * 63, "g" * 64, "A" * 64):
            self.cur.execute("SELECT count(*) FROM public.peek_gateway_enrollment_token(%s);", (value,))
            self.assertEqual(self.cur.fetchone()[0], 0, f"{value!r} was read as live")
        self.cur.execute("SELECT count(*) FROM public.peek_gateway_enrollment_token(NULL);")
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_authenticated_cannot_check_either(self):
        """The check would let a signed-in user learn which token values exist."""
        token, _ = self.issue()
        as_role(self.cur, ADMIN_USER, "Administrator")
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self.cur.execute("SELECT * FROM public.peek_gateway_enrollment_token(%s);", (token,))

    def test_authenticated_cannot_redeem(self):
        """
        Redemption is an appliance's act, performed through enroll-gateway with the service-role
        key. A signed-in user who could call this directly could burn a colleague's live token.
        """
        token, _ = self.issue()
        as_role(self.cur, ADMIN_USER, "Administrator")
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self.cur.execute("SELECT * FROM public.consume_gateway_enrollment_token(%s);", (token,))

    def test_claim_is_atomic_under_concurrency(self):
        """
        TWO CONNECTIONS RACING ONE TOKEN, exactly one winner.

        This is the reason redemption is a function and not three statements in TypeScript. A
        read-then-write in the edge function would let both appliances observe an unconsumed token
        and both receive a credential for the same edge node -- and because the broker's roles pin the
        topic to the username, they would then silently contend for one identity.

        The second connection BLOCKS on the first's row lock until it commits, then re-evaluates
        `consumed_at IS NULL` against the committed row and matches nothing. That is the behaviour
        being asserted, not merely that two calls in sequence differ.
        """
        token, _ = self.issue()
        self.conn.commit()

        first, second = get_connection(), get_connection()
        try:
            c1, c2 = first.cursor(), second.cursor()
            c1.execute("SELECT count(*) FROM public.consume_gateway_enrollment_token(%s);", (token,))
            self.assertEqual(c1.fetchone()[0], 1)
            first.commit()

            c2.execute("SELECT count(*) FROM public.consume_gateway_enrollment_token(%s);", (token,))
            self.assertEqual(
                c2.fetchone()[0], 0,
                "two concurrent redemptions both succeeded -- the claim is not atomic",
            )
            second.commit()
        finally:
            first.close()
            second.close()
            # Committed above, so tearDown's rollback cannot reach it.
            cleanup = get_connection()
            cur = cleanup.cursor()
            cur.execute("DELETE FROM public.gateway_enrollment_tokens WHERE gateway_id = %s;", (REMOTE_GW,))
            cleanup.commit()
            cleanup.close()


class TestGatewayStatusView(GatewayEnrollmentBase):
    def test_view_exposes_the_new_columns(self):
        """
        public.gateway_status is `SELECT g.*, <derived>` and g.* is EXPANDED AT CREATION TIME, so a
        migration that adds a gateways column without calling ensure_gateway_status_view() leaves
        the dashboard's actual read source silently missing it.
        """
        self.cur.execute(
            """
            SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'gateway_status'
               AND column_name IN ('enrolled_at', 'agent_version');
            """
        )
        self.assertEqual(
            sorted(r[0] for r in self.cur.fetchall()), ["agent_version", "enrolled_at"]
        )

    def test_pending_enrollment_is_not_reported_stale(self):
        """A gateway that has never beaten keeps its stored status rather than ageing out."""
        self.issue()
        self.cur.execute(
            "SELECT live_status, is_stale FROM public.gateway_status WHERE id = %s;", (REMOTE_GW,)
        )
        live_status, is_stale = self.cur.fetchone()
        self.assertEqual(live_status, "PENDING_ENROLLMENT")
        self.assertFalse(is_stale)


class TestBrokerCapturePolicies(GatewayEnrollmentBase):
    """
    RLS on the broker-captures bucket, from supabase/storage-policies.sql.

    NOT IN THE MIGRATION, and therefore worth testing from here rather than assuming: those
    policies are applied by a separate Job (storage-policies) because storage.objects does not
    exist until storage-api has migrated it into being, long after db-init has finished. A stack
    where that Job failed has a bucket with NO policies -- which denies everything and looks like
    a broken uploader. Lives here because the prefix rule names a gateway's sparkplug_id.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        conn = get_connection()
        cur = conn.cursor()
        try:
            cur.execute("SELECT to_regclass('storage.objects');")
            if not cur.fetchone()[0]:
                raise unittest.SkipTest("storage.objects does not exist -- storage-api has not booted")
            cur.execute(
                "SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' "
                " AND tablename = 'objects' AND policyname LIKE 'broker_captures_%';"
            )
            if cur.fetchone()[0] != 4:
                raise unittest.SkipTest(
                    "the broker_captures_* policies are not applied -- run supabase/storage-policies.sql"
                )
            cur.execute("SELECT sparkplug_id FROM public.gateways WHERE id = %s;", (REMOTE_GW,))
            cls.sparkplug_id = cur.fetchone()[0]
        finally:
            conn.close()

    def _insert_as(self, user, role, path):
        as_role(self.cur, user, role)
        self.cur.execute(
            "INSERT INTO storage.objects (bucket_id, name) VALUES ('broker-captures', %s);", (path,)
        )

    def test_privileged_roles_may_upload_under_a_real_gateway_prefix(self):
        for user, role in ((ADMIN_USER, "Administrator"), (MANAGER_USER, "Shopfloor_Manager")):
            with self.subTest(role=role):
                self._insert_as(user, role, f"{self.sparkplug_id}/{role}-capture.json")
                self.conn.rollback()

    def test_path_is_confined_to_an_existing_subject(self):
        """
        The client does not get to assert where its data belongs -- the same idea as the broker's
        per-gateway role, one layer up. Storage's REST API is reachable with any authenticated
        session, so a convention the frontend happens to follow would be no control at all.
        """
        for path in (
            "capture.json",                     # no prefix
            "not-a-subject/capture.json",       # prefix names nothing
            "gwy000000000000000000000/c.json",  # well-formed but not a real gateway
            f"../{self.sparkplug_id}/c.json",   # traversal-shaped
        ):
            with self.subTest(path=path):
                with self.assertRaises(
                    pg_errors.InsufficientPrivilege,
                    msg=f"an object was accepted at {path!r}, outside any subject's folder",
                ):
                    self._insert_as(ADMIN_USER, "Administrator", path)
                self.conn.rollback()

    def test_auditor_may_read_but_not_write(self):
        """
        THE ASYMMETRY IS THE DESIGN. An auditor's job is to see what the edge published; letting
        them upload would let them rewrite the record they exist to examine -- the same objection
        that makes audit_trail append-only.
        """
        path = f"{self.sparkplug_id}/auditor-read.json"
        self._insert_as(ADMIN_USER, "Administrator", path)
        self.cur.execute("RESET ROLE;")

        as_role(self.cur, AUDITOR_USER, "Auditor")
        self.cur.execute(
            "SELECT count(*) FROM storage.objects WHERE bucket_id = 'broker-captures' AND name = %s;",
            (path,),
        )
        self.assertEqual(self.cur.fetchone()[0], 1, "Auditor cannot read a capture")

        with self.assertRaises(pg_errors.InsufficientPrivilege, msg="Auditor could upload a capture"):
            self.cur.execute(
                "INSERT INTO storage.objects (bucket_id, name) VALUES ('broker-captures', %s);",
                (f"{self.sparkplug_id}/auditor-write.json",),
            )

    def test_auditor_cannot_delete(self):
        path = f"{self.sparkplug_id}/auditor-delete.json"
        self._insert_as(ADMIN_USER, "Administrator", path)
        self.cur.execute("RESET ROLE;")

        as_role(self.cur, AUDITOR_USER, "Auditor")
        # THE STORAGE SCHEMA REFUSES EVERY DIRECT DELETE BEFORE RLS IS CONSULTED, and without this
        # line the test proves nothing. `storage.protect_objects_delete` is a BEFORE DELETE trigger
        # FOR EACH STATEMENT, so it fires once before any row is examined and raises 42501 at
        # Administrator and Auditor alike -- "Direct deletion from storage tables is not allowed.
        # Use the Storage API instead." A test that reads that as "the Auditor was denied" would
        # pass just as happily with the DELETE policy dropped altogether.
        #
        # `storage.allow_delete_query` is the trigger's own escape hatch, and it is what the Storage
        # API sets when it deletes an object properly. Setting it here puts the statement back in
        # front of RLS, which is the thing under test. Measured: with the hatch set, a role the
        # policy admits deletes the row and a role it does not leaves it standing; without it,
        # both raise. LOCAL, so it dies with the transaction rather than leaking into a later test.
        self.cur.execute("SET LOCAL storage.allow_delete_query = 'true';")
        self.cur.execute(
            "DELETE FROM storage.objects WHERE bucket_id = 'broker-captures' AND name = %s;", (path,)
        )
        # DELETE under RLS removes no row rather than raising -- so the assertion has to be that the
        # object SURVIVED, not that an error was thrown.
        self.cur.execute("RESET ROLE;")
        self.cur.execute(
            "SELECT count(*) FROM storage.objects WHERE bucket_id = 'broker-captures' AND name = %s;",
            (path,),
        )
        self.assertEqual(self.cur.fetchone()[0], 1, "Auditor deleted a capture")

    def test_operator_has_no_access_at_all(self):
        path = f"{self.sparkplug_id}/operator-denied.json"
        self._insert_as(ADMIN_USER, "Administrator", path)
        self.cur.execute("RESET ROLE;")

        as_role(self.cur, OPERATOR_USER, "Operator")
        self.cur.execute(
            "SELECT count(*) FROM storage.objects WHERE bucket_id = 'broker-captures' AND name = %s;",
            (path,),
        )
        self.assertEqual(self.cur.fetchone()[0], 0, "Operator can read captures")

        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self.cur.execute(
                "INSERT INTO storage.objects (bucket_id, name) VALUES ('broker-captures', %s);",
                (f"{self.sparkplug_id}/operator-write.json",),
            )

    def test_bucket_is_private(self):
        """
        `public: true` would make storage-api serve these objects WITHOUT consulting storage.objects
        RLS at all, so the whole role split above would silently stop applying to reads.
        """
        self.cur.execute("SELECT public FROM storage.buckets WHERE id = 'broker-captures';")
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "the broker-captures bucket does not exist")
        self.assertFalse(row[0], "the broker-captures bucket is PUBLIC; it must be private")


# ---------------------------------------------------------------------------------------------
# NO PER-MIGRATION IDEMPOTENCY TEST LIVES HERE, AND ONE CANNOT.
# ---------------------------------------------------------------------------------------------
# psycopg executes SQL, and the baseline opens with psql meta-commands
# (`\if :{?bi_reader_password}`) that only psql understands -- so a test that read a migration and
# ran it twice would be running something other than what db-init runs.
#
# The property is enforced more broadly instead: scripts/check-migration-idempotency.mjs replays
# the WHOLE chain against a live database and asserts the schema digest is unchanged, that no
# 'migration' audit rows were added and that no operator rows were deleted, and
# scripts/verify-schema-equivalence.mjs builds a database from each of two chains and asserts they
# arrive at the same schema and the same seed rows.
#
# The other 30 tests in this file are untouched: they exercise enrolment against a live database,
# which is where the behaviour that matters actually lives.


if __name__ == "__main__":
    unittest.main(verbosity=2)
