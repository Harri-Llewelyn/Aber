"""
The Administrator / Shopfloor_Manager split (migration 0069).

WHAT THIS SUITE IS DEFENDING, because "the manager lost three permissions" is the easy half and
only the first class below is about it:

  1. THE GRANTS DIVERGED, AND STAYED DIVERGED. Both privileged roles held the same thirteen
     permissions from 0002 until 0069, which made the distinction between them presentational.
     0002 no longer seeds the three and 0069 withdraws them from databases that already ran it --
     two mechanisms for one outcome, so a test that only checked the count would pass while one
     of them silently stopped working.

  2. THE WITHDRAWAL REACHES POSTGRES. `role_permissions` IS NOT READ BY ANY RLS POLICY in this
     schema -- every database control resolves through `has_role()` -- so revoking a grant on its
     own hides a button and nothing more. That is the failure `VITE_ALLOW_SIGNUP` was retired for:
     *"a frontend flag and therefore never an access control."* These tests present a real
     Shopfloor_Manager session to the three tables `schema:manage` gates and require a refusal at
     the database, not in the browser.

  3. READING SURVIVED. A manager who cannot see what a device conforms to is a regression dressed
     as hardening, and it is the half most easily lost in a careless repeat of this change. The
     SELECT policies on all three tables stay open to every authenticated user.

Runs against the deployed schema, as a real `authenticated` session with simulated JWT claims --
the same approach as test_system_settings_rls.py and test_user_roles_rls.py. Nothing here mocks
the policy it is testing.

Every test runs inside a transaction that is rolled back. `metric_catalog.name` is immutable by
constraint (0007) and `schemas.schema_name` is unique, so a committed fixture row would be a
permanent addition to a registry this suite has no business writing to.
"""
import os
import unittest
import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# SELF-SEEDED, NOT THE DEMO PERSONAS. CI's RLS job applies the migrations and deliberately not
# seed.sql, so `admin@acs-cymru.local` does not exist there -- a suite depending on it passes
# locally and fails in CI with a failure that looks like the policy and is actually the fixture.
ADMIN_ID = "5e771465-0069-4000-8000-00000000ad11"
MANAGER_ID = "5e771465-0069-4000-8000-00000000009f"

# The three that moved to Administrator, by name. The migration deletes by id for a reason 0049
# recorded -- a rename must not silently stop matching -- but a TEST should fail when the name it
# names has gone, because the name is what the documentation and the UI constant both use.
WITHDRAWN = ("authz:manage", "schema:manage", "gitops:manage")


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def as_user(cur, user_id):
    """Become `authenticated` with a JWT subject, the way PostgREST 12.2 does it: claims only."""
    cur.execute("SET LOCAL ROLE authenticated;")
    cur.execute('SET LOCAL "request.jwt.claims" = %s;', ('{"sub": "%s"}' % user_id,))


class RoleSplitFixture(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                # BY NAME, not by a hardcoded id: `roles.id` is an integer assigned by 0001, and a
                # suite hardcoding 1 == Administrator asserts a fact about a sequence.
                cur.execute(
                    "SELECT id, name FROM public.roles WHERE name IN %s;",
                    (("Administrator", "Shopfloor_Manager"),),
                )
                cls.role_id = {name: rid for rid, name in cur.fetchall()}
                for needed in ("Administrator", "Shopfloor_Manager"):
                    if needed not in cls.role_id:
                        raise RuntimeError(f"role {needed!r} is missing; 0001 did not run cleanly.")

                cur.execute(
                    "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s), (%s, %s)"
                    " ON CONFLICT (user_id, role_id) DO NOTHING;",
                    (ADMIN_ID, cls.role_id["Administrator"],
                     MANAGER_ID, cls.role_id["Shopfloor_Manager"]),
                )
                conn.commit()

                # Asserted rather than assumed. Without this, every refusal below would "pass" by
                # being denied for the wrong reason -- a fixture with no role at all.
                for user_id, expected in ((ADMIN_ID, "Administrator"), (MANAGER_ID, "Shopfloor_Manager")):
                    cur.execute(
                        "SELECT r.name FROM public.user_roles ur"
                        " JOIN public.roles r ON r.id = ur.role_id WHERE ur.user_id = %s;",
                        (user_id,),
                    )
                    roles = [row[0] for row in cur.fetchall()]
                    if expected not in roles:
                        raise RuntimeError(f"fixture user {user_id} is not a {expected}: {roles}")
        finally:
            conn.close()

    def setUp(self):
        self.conn = get_connection()

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()


class TheGrantsDiverged(RoleSplitFixture):

    def test_administrator_holds_every_permission(self):
        with self.conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM public.permissions;")
            total = cur.fetchone()[0]
            cur.execute(
                "SELECT count(*) FROM public.role_permissions WHERE role_id = %s;",
                (self.role_id["Administrator"],),
            )
            self.assertEqual(
                cur.fetchone()[0], total,
                "Administrator must hold every permission -- it is the role the capabilities "
                "0069 withdrew from Shopfloor_Manager moved TO."
            )

    def test_shopfloor_manager_holds_none_of_the_three(self):
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT p.name FROM public.role_permissions rp"
                " JOIN public.permissions p ON p.id = rp.permission_id"
                " WHERE rp.role_id = %s AND p.name IN %s;",
                (self.role_id["Shopfloor_Manager"], WITHDRAWN),
            )
            held = sorted(row[0] for row in cur.fetchall())
            self.assertEqual(
                held, [],
                "Shopfloor_Manager still holds %s. 0002 must not seed them and 0069 must delete "
                "them; one of the two has stopped working." % ", ".join(held)
            )

    def test_the_two_privileged_roles_are_no_longer_the_same_set(self):
        """
        The property, rather than a count. This is what 'presentational' meant: identical sets
        under two names. A future permission granted to both would restore that state without
        touching any of the three names above, and only this test would notice.
        """
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT role_id, permission_id FROM public.role_permissions WHERE role_id IN %s;",
                ((self.role_id["Administrator"], self.role_id["Shopfloor_Manager"]),),
            )
            sets = {"admin": set(), "manager": set()}
            for role_id, perm in cur.fetchall():
                key = "admin" if role_id == self.role_id["Administrator"] else "manager"
                sets[key].add(perm)
            self.assertTrue(
                sets["manager"] < sets["admin"],
                "Shopfloor_Manager's permissions must be a PROPER subset of Administrator's. "
                "Equal sets are the state 0069 exists to end; a manager holding something the "
                "administrator does not is a different bug and this assertion catches both."
            )

    def test_the_manager_keeps_the_shopfloor(self):
        """The withdrawal is three permissions, not a demotion to read-only."""
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT p.name FROM public.role_permissions rp"
                " JOIN public.permissions p ON p.id = rp.permission_id"
                " WHERE rp.role_id = %s;",
                (self.role_id["Shopfloor_Manager"],),
            )
            held = {row[0] for row in cur.fetchall()}
            for kept in ("device:manage", "cell:manage", "gateway:manage",
                         "quarantine:approve", "telemetry:read", "archive:manage"):
                self.assertIn(
                    kept, held,
                    f"Shopfloor_Manager lost {kept}, which is shopfloor work rather than platform "
                    "work. 0069 withdraws three permissions and no others."
                )


class TheWithdrawalReachesPostgres(RoleSplitFixture):
    """
    The half that makes the split an access control instead of a hidden button.

    RLS REFUSES INSERTS AND FILTERS UPDATES AND DELETES, and the two need different assertions.
    A blocked INSERT raises 42501 because a WITH CHECK is a verdict on a row being written. A
    blocked UPDATE or DELETE raises NOTHING: the USING clause removes the row from the statement's
    view, so it reports success over zero rows. This suite was first written asserting an error
    for all four and the UPDATE and DELETE cases failed -- which is the useful direction, because
    a suite written the other way round (`assertEqual(rowcount, 0)` everywhere) would have passed
    against a policy that admitted nobody at all.

    So each silent case pairs the refusal with an Administrator performing the SAME statement on
    the SAME row. Without that second arm, "zero rows changed" is equally consistent with a
    correct policy and with a fixture that never existed.
    """

    def _fixture_schema(self, cur, name):
        """A row to aim at, created out of band. The suite's own transaction is rolled back."""
        cur.execute("RESET ROLE;")
        cur.execute(
            "INSERT INTO public.schemas (schema_name, schema_definition)"
            " VALUES (%s, '{\"metrics\": []}'::jsonb) RETURNING id;",
            (name,),
        )
        return cur.fetchone()[0]

    def _refused_outright(self, statement, params=None):
        """An INSERT the manager may not make: 42501, raised."""
        with self.conn.cursor() as cur:
            as_user(cur, MANAGER_ID)
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                cur.execute(statement, params)

    def _filtered_away(self, statement, fixture_name):
        """
        A statement the manager may issue and that must reach no rows, where an Administrator
        issuing it reaches one.
        """
        with self.conn.cursor() as cur:
            schema_id = self._fixture_schema(cur, fixture_name)

            as_user(cur, MANAGER_ID)
            cur.execute(statement, (schema_id,))
            self.assertEqual(
                cur.rowcount, 0,
                "a Shopfloor_Manager reached the schema registry with:\n  %s\n"
                "0069 narrows this policy to Administrator; the row must be outside the "
                "manager's USING clause entirely." % statement
            )

            cur.execute("RESET ROLE;")
            as_user(cur, ADMIN_ID)
            cur.execute(statement, (schema_id,))
            self.assertEqual(
                cur.rowcount, 1,
                "the Administrator reached no rows either, so the assertion above proved "
                "nothing: the fixture row is not visible to this statement at all."
            )

    def _allowed(self, statement, params=None):
        with self.conn.cursor() as cur:
            as_user(cur, ADMIN_ID)
            cur.execute(statement, params)

    def test_manager_cannot_publish_a_schema(self):
        self._refused_outright(
            "INSERT INTO public.schemas (schema_name, schema_definition)"
            " VALUES ('0069_fixture_schema', '{\"metrics\": []}'::jsonb);"
        )

    def test_administrator_can_publish_a_schema(self):
        """The refusal above must be about the ROLE, not about a broken statement."""
        self._allowed(
            "INSERT INTO public.schemas (schema_name, schema_definition)"
            " VALUES ('0069_fixture_schema', '{\"metrics\": []}'::jsonb);"
        )

    def test_manager_cannot_archive_a_schema(self):
        self._filtered_away(
            "UPDATE public.schemas SET status = 'archived' WHERE id = %s;",
            "0069_fixture_archive",
        )

    def test_manager_cannot_delete_a_schema(self):
        self._filtered_away(
            "DELETE FROM public.schemas WHERE id = %s;",
            "0069_fixture_delete",
        )

    def test_manager_cannot_add_a_metric_to_the_catalog(self):
        # `metric_catalog.name` is immutable once written (0007), which is why the Add Metric form
        # calls its confirmation the last check before something permanent -- and why who may
        # reach it is a platform decision.
        self._refused_outright(
            "INSERT INTO public.metric_catalog (name, datatype)"
            " VALUES ('Fixture0069/Value', 9);"
        )

    def test_administrator_can_add_a_metric_to_the_catalog(self):
        self._allowed(
            "INSERT INTO public.metric_catalog (name, datatype)"
            " VALUES ('Fixture0069/Value', 9);"
        )

    def test_manager_cannot_register_a_metric_group(self):
        self._refused_outright("INSERT INTO public.metric_groups (name) VALUES ('Fixture0069');")

    def test_administrator_can_register_a_metric_group(self):
        self._allowed("INSERT INTO public.metric_groups (name) VALUES ('Fixture0069');")


class ReadingSurvived(RoleSplitFixture):
    """
    A manager who cannot see what a device conforms to is a regression dressed as hardening.

    `schema:manage` is about PUBLISHING a contract, not about reading one: the Devices page
    resolves a device's schema through these tables for every role, and the Schemas page is a
    read surface before it is a write one.
    """

    def _readable(self, table):
        with self.conn.cursor() as cur:
            as_user(cur, MANAGER_ID)
            cur.execute(f"SELECT count(*) FROM public.{table};")
            self.assertIsNotNone(
                cur.fetchone()[0],
                f"a Shopfloor_Manager cannot read public.{table}. 0069 narrows the WRITE policies "
                "on this table and leaves its open SELECT alone."
            )

    def test_manager_can_read_schemas(self):
        self._readable("schemas")

    def test_manager_can_read_the_metric_catalog(self):
        self._readable("metric_catalog")

    def test_manager_can_read_metric_groups(self):
        self._readable("metric_groups")

    def test_manager_still_reads_the_digital_thread(self):
        """
        `digital_thread:read` is NOT one of the three, and the distinction matters: README §22
        proposes splitting that table into asset and security domains and taking the security
        lane away from this role. That is a different item with a different argument, and it
        must not arrive by accident here.
        """
        with self.conn.cursor() as cur:
            as_user(cur, MANAGER_ID)
            cur.execute("SELECT count(*) FROM public.digital_thread;")
            self.assertIsNotNone(cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
