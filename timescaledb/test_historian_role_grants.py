"""
Integration tests for `ingest_writer` and `fdw_reader`.

RUNS AGAINST THE HISTORIAN, NOT SUPABASE, for the same reason test_bi_reader_grants.py does: these
roles exist on the standalone TimescaleDB instance, and a grant issued on the Supabase side would
apply cleanly and grant nothing here.

    python timescaledb/test_historian_role_grants.py

Requires the stack up, with INGEST_WRITER_PASSWORD and FDW_READER_PASSWORD set to whatever
roles.sql was applied with. Each role skips its own tests when its password is absent, because
roles.sql skips creating the role on the same condition -- a deployment that has not opted in
should report "not configured", not "failing".

=================================================================================================
WHAT THESE PROTECT

The ingestion daemon connected to this database as `postgres`. It is, in this repository's own
words, "the process most exposed to the plant network", and it held superuser: it could DROP the
hypertable and rewrite any observation. Meanwhile the README's security model listed "append-only
historian writes" as an ingestion-layer control, enforced entirely by the Python.

THE NEGATIVE HALF IS THE POINT, and it is worth saying why the positive half is not filler. A role
that cannot write is a fleet with no telemetry: loud, immediate, fixed in minutes. A role that can
still DELETE is a security claim the README makes and the database does not keep, and nothing
surfaces that until someone audits it. Both are asserted; only one of them would be noticed on its
own.

THE GRANT LIST IS NOT WHAT YOU WOULD GUESS, and the tests encode the measurement rather than the
guess. `ingest_writer` needs SELECT on both tables, not just INSERT -- every statement the daemon
issues carries an ON CONFLICT clause, and inferring the arbiter index reads the target. The grant list
entry that specified this feature got it wrong; a probe role got it right.

THE HYPERTABLE IS THE SUBTLE ONE. `telemetry` is a hypertable, so rows land in chunks. If a grant
on the parent did not reach them, ingestion would break when the NEXT chunk was created -- days
later, with nothing connecting cause to effect. test_insert_reaches_a_chunk is the guard.
"""
import os
import unittest

import psycopg2

DB_HOST = os.getenv("TS_TEST_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("TS_TEST_PORT", "5433")
DB_NAME = os.getenv("DB_NAME", "postgres")

ADMIN_USER = os.getenv("DB_USER", "postgres")
ADMIN_PASSWORD = os.getenv("DB_PASSWORD", "postgres")

WRITER_USER = os.getenv("INGEST_WRITER_USER", "ingest_writer")
WRITER_PASSWORD = os.getenv("INGEST_WRITER_PASSWORD", "")

READER_USER = os.getenv("FDW_READER_USER", "fdw_reader")
READER_PASSWORD = os.getenv("FDW_READER_PASSWORD", "")

PROBE_METRIC = "_item18_grant_probe"


def connect(user, password):
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=user, password=password
    )
    conn.autocommit = False
    return conn


def role_exists(name):
    conn = connect(ADMIN_USER, ADMIN_PASSWORD)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (name,))
            return cur.fetchone() is not None
    finally:
        conn.close()


class IngestWriterTestCase(unittest.TestCase):
    """
    Every test rolls back. The historian is append-only to this role by design, so a committed
    probe row could not be removed by the role that wrote it -- which is the property under test.
    """

    @classmethod
    def setUpClass(cls):
        if not WRITER_PASSWORD:
            raise unittest.SkipTest(
                "INGEST_WRITER_PASSWORD is not set, so roles.sql skipped creating ingest_writer"
            )
        if not role_exists(WRITER_USER):
            raise unittest.SkipTest(f"{WRITER_USER} does not exist; run timescaledb-maintenance")

        # An asset to hang telemetry off: `telemetry` has a foreign key to `assets`, so a probe
        # row for an unknown asset fails on the constraint rather than on a privilege, which would
        # make every test below report the wrong cause.
        conn = connect(ADMIN_USER, ADMIN_PASSWORD)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT asset_id FROM assets LIMIT 1")
                row = cur.fetchone()
                if not row:
                    raise unittest.SkipTest("no assets seeded on the historian")
                cls.asset_id = row[0]
        finally:
            conn.close()

    def setUp(self):
        self.conn = connect(WRITER_USER, WRITER_PASSWORD)
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()
        self.conn.close()

    # -- what it must be able to do ---------------------------------------------------------------

    def test_upserts_an_asset(self):
        """The daemon's first statement, verbatim. Needs INSERT, UPDATE *and* SELECT."""
        self.cur.execute(
            "INSERT INTO assets (asset_id, asset_name) VALUES (%s, %s) "
            "ON CONFLICT (asset_id) DO UPDATE SET asset_name = EXCLUDED.asset_name",
            (self.asset_id, "probe"),
        )

    def test_insert_reaches_a_chunk(self):
        """
        THE TIME-DELAYED FAILURE THIS GUARDS. `telemetry` is a hypertable and the row lands in a
        chunk. If privileges did not propagate from the parent, ingestion would break when the next
        chunk was created rather than when this role was adopted.
        """
        self.cur.execute(
            "INSERT INTO telemetry (time, asset_id, metric_name, val_double) "
            "VALUES (now(), %s, %s, 1.0) "
            "ON CONFLICT (time, asset_id, metric_name) DO NOTHING",
            (self.asset_id, PROBE_METRIC),
        )
        self.assertEqual(self.cur.rowcount, 1)

    def test_can_select_both_tables(self):
        """
        Not a convenience. Both of the daemon's statements carry ON CONFLICT, and inferring the
        arbiter index requires SELECT on the target -- without it the upsert fails with
        `permission denied for table assets`, which reads as a missing write grant.
        """
        self.cur.execute("SELECT count(*) FROM assets")
        self.cur.execute("SELECT count(*) FROM telemetry LIMIT 1")

    # -- what it must NOT be able to do -----------------------------------------------------------

    def test_cannot_update_telemetry(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("UPDATE telemetry SET val_double = 0 WHERE metric_name = %s",
                             (PROBE_METRIC,))

    def test_cannot_delete_telemetry(self):
        """
        The one that makes "append-only historian writes" true. Until this role existed, that claim
        in the README's security model was enforced by the Python and by nothing else.
        """
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("DELETE FROM telemetry WHERE metric_name = %s", (PROBE_METRIC,))

    def test_cannot_truncate_telemetry(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("TRUNCATE telemetry")

    def test_cannot_drop_or_create(self):
        """No DDL. A writer that can DROP is a superuser with extra steps."""
        with self.assertRaises(psycopg2.Error):
            self.cur.execute("DROP TABLE assets")
        self.conn.rollback()
        with self.assertRaises(psycopg2.Error):
            self.cur.execute("CREATE TABLE _probe_ddl (x int)")

    def test_cannot_read_the_rollups(self):
        """
        Derived data the daemon has no business reading. It writes raw observations; TimescaleDB
        derives the aggregates from them.
        """
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("SELECT count(*) FROM telemetry_1h")

    def test_is_not_a_superuser(self):
        self.cur.execute("SELECT rolsuper FROM pg_roles WHERE rolname = %s", (WRITER_USER,))
        self.assertFalse(self.cur.fetchone()[0])


class FdwReaderTestCase(unittest.TestCase):
    """
    What Supabase's postgres_fdw PUBLIC user mapping authenticates as. Before item 18 that mapping
    ran as this database's superuser, contained only by the LOCAL grant on the Supabase side -- so
    the remote end contributed nothing to the containment.
    """

    @classmethod
    def setUpClass(cls):
        if not READER_PASSWORD:
            raise unittest.SkipTest(
                "FDW_READER_PASSWORD is not set, so roles.sql skipped creating fdw_reader"
            )
        if not role_exists(READER_USER):
            raise unittest.SkipTest(f"{READER_USER} does not exist; run timescaledb-maintenance")

    def setUp(self):
        self.conn = connect(READER_USER, READER_PASSWORD)
        self.cur = self.conn.cursor()

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()
        self.conn.close()

    def test_reads_every_object_supabase_projects(self):
        """
        The positive half, and it is not filler: a missing grant here is every telemetry query in
        the dashboard failing with permission denied through the FDW, reported as a database fault.
        """
        for relation in ("telemetry", "telemetry_latest", "telemetry_1m", "telemetry_5m",
                         "telemetry_1h"):
            with self.subTest(relation=relation):
                self.cur.execute(f"SELECT 1 FROM {relation} LIMIT 1")

    def test_cannot_write_telemetry(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute(
                "INSERT INTO telemetry (time, asset_id, metric_name, val_double) "
                "VALUES (now(), 'x', %s, 1.0)", (PROBE_METRIC,))

    def test_cannot_delete_telemetry(self):
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("DELETE FROM telemetry")

    def test_is_not_a_superuser(self):
        self.cur.execute("SELECT rolsuper FROM pg_roles WHERE rolname = %s", (READER_USER,))
        self.assertFalse(self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
