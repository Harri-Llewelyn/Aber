"""
How far behind the cold archive is (0133).

WHAT THIS SUITE CAN AND CANNOT SEE, stated first because it decides every assertion below. It runs
against the Supabase database, and the backlog is computed from two FOREIGN tables on the historian.
The db lane has no historian behind the FDW -- `0001` defaults the connection and the chain applies
without one -- so with archiving on, `cold_archive_backlog_state()` here takes its "cannot be
computed" path. That is not a gap in the suite; it is the single most important state to pin,
because it is the one the whole platform's alerting was briefly resting on. The tests that need it
turn archiving on inside their own transaction, which tearDown rolls back. With archiving off the
function answers without reading the historian, and the missing historian is what proves it.

THE REGRESSION THIS EXISTS FOR. `platform_health_rows()` is one UNION and postgres_fdw raises on
CONNECT, not on scan. The first version of 0133 read the foreign tables directly in a new arm, so an
unreachable historian raised inside the health view and took gateway staleness, stuck enrolments,
the quarantine queue and expected publishers down with it -- four conditions that have nothing to do
with the archive, unavailable exactly when the database they describe is in trouble. The state
function now returns NO ROW instead of raising, and `test_the_health_view_survives_an_unreachable_historian`
is that property.

The arithmetic (overdue days, the frontier, the one-chunk-interval tolerance) needs a historian with
a manifest in it and belongs to a stack-lane test; `ingestion/test_cold_archive.py` covers the
object layout on the other side of the same feature.

    python supabase/migrations/test_cold_archive_backlog.py
"""
import os
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

STATE_FN = "public.cold_archive_backlog_state()"
PAGE_FN = "public.cold_archive_backlog()"

# Emitted even at zero by `0092`, so their absence means the view lost an arm rather than that the
# fleet is healthy.
ALWAYS_EMITTED = ("quarantine_depth", "expected_publishers")


def get_connection():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )


class ColdArchiveBacklog(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                for fn in (STATE_FN, PAGE_FN):
                    cur.execute("SELECT to_regprocedure(%s);", (fn,))
                    if cur.fetchone()[0] is None:
                        raise RuntimeError(f"{fn} does not exist -- 0133 did not run.")
        finally:
            conn.close()

    def setUp(self):
        self.conn = get_connection()

    def tearDown(self):
        # Read-only throughout, but rolled back anyway: a suite that leaves a transaction open holds
        # locks on the catalogue for whatever runs next.
        self.conn.rollback()
        self.conn.close()

    def _archiving_on(self, cur):
        cur.execute(
            "UPDATE public.system_settings SET value = 'true'::jsonb WHERE key = 'archive.enabled';"
        )
        self.assertEqual(cur.rowcount, 1, "archive.enabled is not seeded")

    # -- the property the health view rests on ---------------------------------------------------

    def test_the_health_view_survives_an_unreachable_historian(self):
        """
        THE REGRESSION TEST. Every other condition in the view must still be readable when the
        archive's arm cannot answer.

        An FDW error here does not fail politely: it aborts the whole statement, so the assertion
        is simply that the query returns -- and that the two conditions which are emitted even at
        zero are among what comes back.
        """
        with self.conn.cursor() as cur:
            self._archiving_on(cur)
            cur.execute("SELECT DISTINCT condition FROM public.platform_health_rows();")
            conditions = {row[0] for row in cur.fetchall()}

        for condition in ALWAYS_EMITTED:
            self.assertIn(
                condition, conditions,
                f"{condition} is missing from platform_health_rows(). It is emitted even at zero, "
                f"so its absence means an arm of the UNION was dropped or raised. Got: {conditions}",
            )

    def test_the_backlog_arm_reports_nothing_rather_than_zero(self):
        """
        "Cannot be computed" must not arrive as "nothing is overdue".

        A zero would be a specific, reassuring claim about an archive this database cannot see, and
        the alert rule would read it as healthy for as long as the historian stayed away.
        """
        with self.conn.cursor() as cur:
            self._archiving_on(cur)
            cur.execute(
                "SELECT count(*) FROM public.platform_health_rows() WHERE condition = 'archive_backlog';"
            )
            self.assertEqual(
                cur.fetchone()[0], 0,
                "archive_backlog was emitted although the historian is unreachable. With no "
                "frontier to measure from, any value here is invented.",
            )

    def test_with_archiving_off_the_historian_is_not_read(self):
        """
        Every platform_health alert query calls the state function, and the historian read behind
        it costs a few hundred ms. Off is the default, so off must cost nothing: one row, enabled
        false, no frontier. A row at all proves it, because this lane has no historian to read.
        """
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT enabled, oldest_unexported, overdue_seconds "
                "FROM public.cold_archive_backlog_state();"
            )
            rows = cur.fetchall()
        self.assertEqual(
            rows, [(False, None, None)],
            "with archiving off the state function should answer from the settings alone",
        )

    # -- the shape of the state function ----------------------------------------------------------

    def test_it_returns_one_row_or_none_and_never_more(self):
        """
        Both wrappers and the alert's reducer take `last`, so a second row would make which state
        wins a matter of scan order.
        """
        with self.conn.cursor() as cur:
            cur.execute(f"SELECT count(*) FROM {STATE_FN};")
            self.assertLessEqual(cur.fetchone()[0], 1)

    def test_it_does_not_raise_when_called_directly(self):
        """The exception handler is the function's, not its callers': anything may call it safely."""
        with self.conn.cursor() as cur:
            cur.execute(f"SELECT * FROM {STATE_FN};")
            cur.fetchall()

    # -- who may ask ------------------------------------------------------------------------------

    def test_the_internal_function_is_not_reachable_from_postgrest(self):
        """
        `cold_archive_backlog_state()` has no role gate -- it is the shared arithmetic -- so the
        gate is that no browser role may call it. A GRANT here would expose the ungated answer to
        every signed-in user, which is precisely what the wrapper exists to prevent.
        """
        with self.conn.cursor() as cur:
            for role in ("authenticated", "anon"):
                cur.execute("SELECT has_function_privilege(%s, %s, 'EXECUTE');", (role, STATE_FN))
                self.assertFalse(
                    cur.fetchone()[0],
                    f"{role} may EXECUTE {STATE_FN}, which bypasses the role check in {PAGE_FN}.",
                )

    def test_the_page_function_is_reachable_from_postgrest(self):
        """The negative above is only meaningful beside this: the gated wrapper must be callable."""
        with self.conn.cursor() as cur:
            cur.execute("SELECT has_function_privilege('authenticated', %s, 'EXECUTE');", (PAGE_FN,))
            self.assertTrue(
                cur.fetchone()[0],
                f"authenticated cannot EXECUTE {PAGE_FN}; the Cold Storage page would show no "
                "backlog figure and report no error either.",
            )

    def test_a_caller_holding_no_role_is_given_nothing(self):
        """
        The gate is `has_role(...)` inside a SECURITY DEFINER function, so a session with no claims
        must come back empty rather than inheriting the definer's reach.
        """
        with self.conn.cursor() as cur:
            cur.execute("SET LOCAL ROLE authenticated;")
            cur.execute(f"SELECT count(*) FROM {PAGE_FN};")
            self.assertEqual(
                cur.fetchone()[0], 0,
                "a caller with no role received a row from a SECURITY DEFINER function.",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
