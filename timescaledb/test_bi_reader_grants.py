"""
Integration tests for the read-only BI role created by timescaledb/roles.sql.

RUNS AGAINST THE HISTORIAN, NOT SUPABASE. The rollups live on the standalone TimescaleDB instance;
`public.telemetry` in Supabase is a postgres_fdw projection and a grant issued there would apply
cleanly and grant nothing here. Getting that wrong is the single most likely way this role ends up
misconfigured, so the connection details below default to the historian's published port (5433).

    python timescaledb/test_bi_reader_grants.py

Requires the stack up and BI_READER_PASSWORD set to whatever roles.sql was applied with.

---------------------------------------------------------------------------------------------
BOTH HALVES MATTER, AND THE NEGATIVE HALF MATTERS MORE.

A role that cannot read the rollups is a broken dashboard -- annoying, immediately obvious, fixed
in minutes. A role that CAN read everything is a reporting tool holding a credential over every
individual observation in the historian, which is invisible until someone audits it. So the
"is refused" tests are not symmetry for its own sake; they are the ones protecting the property
the role exists to have.

WHY THE POSITIVE HALF IS NOT OBVIOUS EITHER. With `materialized_only = false` a continuous
aggregate unions its materialised buckets with the raw hypertable tail -- so `telemetry_1h`
genuinely reads `telemetry` while executing. It works because a non-security_invoker view runs with
its OWNER's privileges, which is the standard PostgreSQL indirection, and it is why granting the
view without the table is sufficient rather than an oversight. That property is easy to lose (a
future `security_invoker = true`, or replacing the view with something else) and its loss would be
reported as "Grafana stopped working" rather than as a privilege change. Hence
test_can_read_the_rollup_that_unions_raw.
"""
import os
import unittest

import psycopg2

# The HISTORIAN, not Supabase. 5433 is where `npm run dev:test` forwards it.
DB_HOST = os.getenv("TS_TEST_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("TS_TEST_PORT", "5433")
DB_NAME = os.getenv("DB_NAME", "postgres")
BI_USER = os.getenv("BI_READER_USER", "powerbi_reader")
BI_PASSWORD = os.getenv("BI_READER_PASSWORD", "")

ADMIN_USER = os.getenv("DB_USER", "postgres")
ADMIN_PASSWORD = os.getenv("DB_PASSWORD", "")

ROLLUPS = ("telemetry_1m", "telemetry_5m", "telemetry_1h")
FORBIDDEN = ("telemetry", "assets", "telemetry_latest")


def connect(user, password):
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=user, password=password
    )


class BiReaderTestCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not BI_PASSWORD:
            raise unittest.SkipTest(
                "BI_READER_PASSWORD is not set; roles.sql skips the role when it is empty, so "
                "there would be nothing to test against."
            )
        try:
            cls.conn = connect(BI_USER, BI_PASSWORD)
        except psycopg2.OperationalError as exc:
            raise unittest.SkipTest(
                f"cannot connect as {BI_USER} ({exc}). Is the stack up and has "
                "timescaledb-maintenance run with this password?"
            )
        cls.conn.autocommit = True

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "conn", None):
            cls.conn.close()

    def cursor(self):
        return self.conn.cursor()


class TestTheRoleCanReadTheRollups(BiReaderTestCase):

    def test_can_select_from_each_rollup(self):
        for view in ROLLUPS:
            with self.subTest(view=view), self.cursor() as cur:
                cur.execute(f"SELECT count(*) FROM public.{view}")
                self.assertIsNotNone(cur.fetchone()[0])

    def test_can_read_the_rollup_that_unions_raw(self):
        """
        The property this whole grant list rests on. Real-time aggregation makes telemetry_1h read
        the raw hypertable while executing; the reader has no privilege on that table and must
        still succeed, because the view executes as its owner.
        """
        with self.cursor() as cur:
            cur.execute(
                "SELECT bucket, asset_id, metric_name, sum_double, n_double "
                "FROM public.telemetry_1h "
                "WHERE bucket > now() - interval '2 days' LIMIT 5"
            )
            cur.fetchall()  # no exception is the assertion

    def test_can_compute_an_average_the_way_a_dashboard_would(self):
        """sum/n rather than avg(avg) -- the arithmetic aggregates.sql exists to make possible."""
        with self.cursor() as cur:
            cur.execute(
                "SELECT metric_name, sum(sum_double) / NULLIF(sum(n_double), 0) "
                "FROM public.telemetry_1h "
                "WHERE bucket > now() - interval '7 days' "
                "GROUP BY metric_name LIMIT 5"
            )
            cur.fetchall()


class TestTheRoleIsRefusedEverythingElse(BiReaderTestCase):

    def test_raw_telemetry_is_refused(self):
        """
        The headline restriction. A BI tool reading raw defeats the purpose of the rollups and
        carries read access to every individual observation.
        """
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            with self.cursor() as cur:
                cur.execute("SELECT * FROM public.telemetry LIMIT 1")

    def test_telemetry_latest_is_refused(self):
        """A DISTINCT ON over raw, carrying the same exposure by another route."""
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            with self.cursor() as cur:
                cur.execute("SELECT * FROM public.telemetry_latest LIMIT 1")

    def test_assets_is_refused(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            with self.cursor() as cur:
                cur.execute("SELECT * FROM public.assets LIMIT 1")

    def test_the_role_holds_no_insert_privilege_on_a_rollup(self):
        """
        SELECT was granted; INSERT was not, and `GRANT SELECT` implies nothing else.

        Asserted as a PRIVILEGE rather than by attempting the statement, because the statement
        fails for a second, unrelated reason and would pass this test even if the grant were
        wrong -- see the next test.
        """
        with self.cursor() as cur:
            cur.execute(
                "SELECT has_table_privilege(current_user, 'public.telemetry_1h', 'INSERT'), "
                "       has_table_privilege(current_user, 'public.telemetry_1h', 'UPDATE'), "
                "       has_table_privilege(current_user, 'public.telemetry_1h', 'DELETE')"
            )
            self.assertEqual(cur.fetchone(), (False, False, False))

    def test_writes_to_a_rollup_are_refused(self):
        """
        TWO INDEPENDENT REASONS, AND THE TEST ACCEPTS EITHER.

        `InsufficientPrivilege` is the one this grant list is responsible for. But a continuous
        aggregate with real-time aggregation on is a UNION view, and PostgreSQL will not
        auto-update a UNION view for anybody -- so the statement can also fail with
        `ObjectNotInPrerequisiteState` before privileges are ever consulted, which is what it
        actually does here.

        That is a stronger guarantee than the grant, not a weaker one, but it means this statement
        cannot distinguish a correct grant from a missing one. It is kept as a belt-and-braces
        check that the write does not somehow succeed; the privilege itself is asserted above.
        """
        with self.assertRaises((psycopg2.errors.InsufficientPrivilege,
                                psycopg2.errors.ObjectNotInPrerequisiteState)):
            with self.cursor() as cur:
                cur.execute(
                    "INSERT INTO public.telemetry_1h (bucket, asset_id, metric_name) "
                    "VALUES (now(), 'x', 'y')"
                )

    def test_writes_to_raw_telemetry_are_refused(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            with self.cursor() as cur:
                cur.execute(
                    "INSERT INTO public.telemetry (time, asset_id, metric_name, val_double) "
                    "VALUES (now(), 'x', 'y', 1.0)"
                )

    def test_cannot_create_objects_in_public(self):
        """USAGE on the schema was granted; CREATE was not."""
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            with self.cursor() as cur:
                cur.execute("CREATE TABLE public.bi_reader_should_not_manage (id int)")


class TestTheRoleItself(BiReaderTestCase):

    def test_is_not_a_superuser(self):
        with self.cursor() as cur:
            cur.execute("SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user")
            rolsuper, rolcreatedb, rolcreaterole = cur.fetchone()
            self.assertFalse(rolsuper, "the BI role is a superuser")
            self.assertFalse(rolcreatedb, "the BI role can create databases")
            self.assertFalse(rolcreaterole, "the BI role can create roles")

    def test_grants_match_the_allow_list_exactly(self):
        """
        Catches a widening nobody meant -- a `GRANT SELECT ON ALL TABLES` run by hand, or a future
        table inheriting a default privilege. Asserted as a set rather than per-table so an
        ADDITION fails too, which a per-table check would miss.
        """
        with self.cursor() as cur:
            cur.execute(
                "SELECT table_name FROM information_schema.table_privileges "
                " WHERE grantee = current_user AND table_schema = 'public' "
                "   AND privilege_type = 'SELECT'"
            )
            granted = {row[0] for row in cur.fetchall()}
        self.assertEqual(
            granted, set(ROLLUPS),
            f"the BI role's SELECT grants are {sorted(granted)}, expected exactly {sorted(ROLLUPS)}"
        )

    def test_none_of_the_forbidden_relations_are_readable(self):
        with self.cursor() as cur:
            for relation in FORBIDDEN:
                with self.subTest(relation=relation):
                    cur.execute(
                        "SELECT has_table_privilege(current_user, %s, 'SELECT')",
                        (f"public.{relation}",),
                    )
                    self.assertFalse(
                        cur.fetchone()[0],
                        f"the BI role can SELECT public.{relation}, which it must not",
                    )


class TestIdempotency(unittest.TestCase):
    """
    roles.sql is replayed on every boot. Re-applying it must not widen the grants, and must not
    fail against a role that already exists -- which a DROP/CREATE pair would, since a connected
    session blocks the drop.
    """

    def test_role_survives_reapplication(self):
        if not ADMIN_PASSWORD:
            self.skipTest("DB_PASSWORD is not set; cannot re-apply roles.sql as the owner.")
        try:
            admin = connect(ADMIN_USER, ADMIN_PASSWORD)
        except psycopg2.OperationalError as exc:
            self.skipTest(f"cannot connect as {ADMIN_USER} ({exc})")

        admin.autocommit = True
        try:
            with admin.cursor() as cur:
                cur.execute("SELECT count(*) FROM pg_roles WHERE rolname = %s", (BI_USER,))
                self.assertEqual(cur.fetchone()[0], 1, f"{BI_USER} was not created")

                # The grants roles.sql makes, exactly as it makes them, against a role that is
                # already present and (in this suite) already connected.
                for view in ROLLUPS:
                    cur.execute(f"GRANT SELECT ON public.{view} TO {BI_USER}")
                for relation in FORBIDDEN:
                    cur.execute(f"REVOKE ALL ON public.{relation} FROM {BI_USER}")

                cur.execute(
                    "SELECT has_table_privilege(%s, 'public.telemetry_1h', 'SELECT'), "
                    "       has_table_privilege(%s, 'public.telemetry', 'SELECT')",
                    (BI_USER, BI_USER),
                )
                can_rollup, can_raw = cur.fetchone()
                self.assertTrue(can_rollup)
                self.assertFalse(can_raw)
        finally:
            admin.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
