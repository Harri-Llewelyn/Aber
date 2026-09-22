"""
The installed TimescaleDB extension matches the version the image ships.

    python timescaledb/test_extension_version.py

RUNS AGAINST THE HISTORIAN (port 5433), not Supabase, for the same reason the other suites in this
directory do: the extension being asserted is the one under `telemetry`, and Supabase's
`public.telemetry` is a postgres_fdw projection whose own database has no TimescaleDB in it.

---------------------------------------------------------------------------------------------
WHAT THIS CATCHES, AND WHY A RUNTIME ASSERT WAS NOT ENOUGH ON ITS OWN.

Bumping the image tag upgrades the binaries and leaves the SQL-level extension where it was, so a
2.29.2 image ran 2.29.1's definitions for as long as nobody looked. `timescaledb/extension.sql`
both fixes that on every boot and refuses to finish while the two disagree -- but only while it is
still WIRED IN. Delete the psql call from the maintenance Job and the file becomes a mirror nobody
runs, with no error anywhere: exactly the shape of the original defect.

So there are two tests here and they fail in different circumstances. The first asks the running
database. The second asks the Job that is supposed to update it, and needs no stack at all, which
is what makes it useful in an environment where the historian is not up.
"""
import os
import re
import unittest
from pathlib import Path

import psycopg2

# The HISTORIAN, not Supabase. 5433 is where `npm run dev:test` forwards it.
DB_HOST = os.getenv("TS_TEST_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("TS_TEST_PORT", "5433")
DB_NAME = os.getenv("DB_NAME", "postgres")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")

REPO = Path(__file__).resolve().parent.parent
HELM_JOB = REPO / "deploy" / "helm" / "aber" / "templates" / "jobs" / "timescaledb-maintenance.yaml"
MIRROR = REPO / "deploy" / "helm" / "aber" / "files" / "timescaledb-maintenance" / "extension.sql"


class ExtensionVersionTestCase(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        if not DB_PASSWORD:
            raise unittest.SkipTest("DB_PASSWORD is unset; run this through `npm run dev:test`.")
        cls.conn = psycopg2.connect(
            host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
        )

    @classmethod
    def tearDownClass(cls):
        conn = getattr(cls, "conn", None)
        if conn is not None:
            conn.close()

    def test_installed_version_matches_the_image(self):
        """The database runs the definitions the image's library belongs to."""
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT default_version, installed_version "
                "FROM pg_available_extensions WHERE name = 'timescaledb'"
            )
            row = cur.fetchone()

        self.assertIsNotNone(row, "timescaledb is not available in this database at all.")
        default_version, installed_version = row
        self.assertIsNotNone(
            installed_version,
            "timescaledb is available but not installed. It is created by "
            "timescaledb/init/001_schema.sql, which runs only on an EMPTY data directory.",
        )
        self.assertEqual(
            installed_version,
            default_version,
            f"the image ships timescaledb {default_version} and the database is running "
            f"{installed_version}. Postgres loads the library matching the INSTALLED version, so "
            f"this database is executing one release's SQL against another's binaries. "
            f"the timescaledb-maintenance Job (re-run by helm upgrade) applies timescaledb/extension.sql, "
            f"which is what closes it.",
        )


class MaintenancePathTestCase(unittest.TestCase):
    """
    No database needed. The maintenance Job must actually RUN the file.

    The chart mounts a mirrored copy of this directory, so the mirror being current is asserted
    alongside the invocation: a stale copy is a step nobody runs with an extra file in the way.
    """

    def test_helm_job_runs_extension_sql(self):
        job = HELM_JOB.read_text(encoding="utf-8")
        self.assertIn(
            "-f /sql/extension.sql",
            job,
            "the timescaledb-maintenance Job no longer applies extension.sql, so a Kubernetes "
            "deployment upgrades its image and leaves the extension behind.",
        )

    def test_the_extension_update_runs_before_everything_else(self):
        """
        FIRST, and that ordering is not cosmetic.

        `ALTER EXTENSION` is refused once a connection has loaded the old version's library, and
        every other file in this directory uses the API surface the update changes -- the
        compression/columnstore rename in docs/postgres-17-migration-plan.md being the case that
        makes it concrete.
        """
        path, prefix = HELM_JOB, "-f /sql/"
        text = path.read_text(encoding="utf-8")
        # The INVOCATIONS, not the first mention of each name: the template discusses these scripts
        # in comments long before it runs any of them, and comparing prose positions would assert
        # the order the header happens to introduce them in.
        first = text.index(f"{prefix}extension.sql")
        for later in ("retention.sql", "aggregates.sql", "storage.sql", "roles.sql"):
            self.assertLess(
                first,
                text.index(f"{prefix}{later}"),
                f"{path.name} applies {later} before extension.sql.",
            )

    def test_the_chart_mirror_is_present_and_current(self):
        self.assertTrue(
            MIRROR.exists(),
            "the chart's copy of extension.sql is missing. Run: "
            "node scripts/sync-helm-chart-files.mjs",
        )
        self.assertEqual(
            MIRROR.read_text(encoding="utf-8"),
            (REPO / "timescaledb" / "extension.sql").read_text(encoding="utf-8"),
            "the chart's copy of extension.sql is stale. Run: "
            "node scripts/sync-helm-chart-files.mjs",
        )

    def test_the_update_asserts_its_own_outcome(self):
        """
        The file must keep the check that made the drift visible, not just the statement that
        fixes it. An `ALTER EXTENSION` whose result nobody reads is how this was missed for as
        long as it was.
        """
        sql = (REPO / "timescaledb" / "extension.sql").read_text(encoding="utf-8")
        self.assertRegex(sql, r"ALTER\s+EXTENSION\s+timescaledb\s+UPDATE\s*;")
        self.assertTrue(
            re.search(r"IS\s+DISTINCT\s+FROM", sql, re.I)
            and "installed_version" in sql
            and "RAISE EXCEPTION" in sql,
            "extension.sql no longer fails when the versions disagree after the update.",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
