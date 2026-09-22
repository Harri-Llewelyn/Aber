"""
The historian's worker pool is large enough for the workers it may launch.

    python timescaledb/test_worker_pool.py

RUNS AGAINST THE HISTORIAN (port 5433), like the other suites here.

---------------------------------------------------------------------------------------------
WHAT THIS CATCHES.

`max_worker_processes` is Postgres's pool; `timescaledb.max_background_workers` is how many workers
TimescaleDB believes it may schedule jobs into; `max_parallel_workers` draws from the same pool.
Left at their defaults the first is 8 and the second is 16, which is not a tuning choice -- it is
two projects' defaults meeting in the middle. The result was 189 log lines of

    WARNING: failed to launch job 2211 "...": failed to start a background worker

and the jobs recorded as failures in `timescaledb_information.job_errors`. Every one retried and
eventually succeeded, which is exactly why it survived so long: nothing downstream looked wrong.

A refresh policy feeds the trend panels and a retention policy is a hard delete, so a window that
is skipped because no worker was free is invisible in both directions.

TWO KINDS OF TEST, FAILING IN DIFFERENT CIRCUMSTANCES. The first asks the running server what it
actually has. The second asks the chart, needs no stack, and is what catches the arithmetic being
pinned to a number that stops tracking its own terms.
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
VALUES = REPO / "deploy" / "helm" / "aber" / "values.yaml"
STATEFULSET = (
    REPO / "deploy" / "helm" / "aber" / "templates" / "data" / "timescaledb-statefulset.yaml"
)

# The launcher, which is one process per instance and outside the background-worker pool.
LAUNCHER = 1


class WorkerPoolTestCase(unittest.TestCase):

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

    def setting(self, name):
        with self.conn.cursor() as cur:
            cur.execute("SELECT current_setting(%s)::int", (name,))
            return cur.fetchone()[0]

    def test_the_pool_covers_every_worker_that_may_want_it(self):
        """Upstream's arithmetic: 1 + max_background_workers + max_parallel_workers."""
        pool = self.setting("max_worker_processes")
        background = self.setting("timescaledb.max_background_workers")
        parallel = self.setting("max_parallel_workers")
        required = LAUNCHER + background + parallel

        self.assertGreaterEqual(
            pool,
            required,
            f"max_worker_processes is {pool}, and the workers that may ask for a slot are "
            f"{background} background + {parallel} parallel + {LAUNCHER} launcher = {required}. "
            f"Policy jobs that come due together will fail to launch, retry, and leave nothing "
            f"behind but a WARNING. The chart sets these explicitly -- see the historian's "
            f"`args:` in timescaledb-statefulset.yaml.",
        )

    def test_the_settings_were_chosen_rather_than_inherited(self):
        """
        `source = default` on all three is the state this closes.

        Not a style point: it means nobody picked them, so the next upstream default moves the
        stack without anyone deciding to. A restart onto a volume whose server was started without
        the flags reads exactly this way.
        """
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT name, source FROM pg_settings WHERE name IN "
                "('max_worker_processes', 'timescaledb.max_background_workers', "
                "'max_parallel_workers')"
            )
            sources = dict(cur.fetchall())

        inherited = [name for name, source in sources.items() if source == "default"]
        self.assertEqual(
            inherited,
            [],
            f"{', '.join(inherited)} still read `source = default`, so this server was started "
            f"without the flags that pin them. Recreate the pod: "
            f"`kubectl rollout restart statefulset/timescaledb`.",
        )

    def test_no_job_failed_to_launch_since_this_server_started(self):
        """
        The symptom itself, asked of the database rather than of a log.

        Scoped to launch failures and to THIS postmaster: a job that failed for its own reasons is
        a different fault, and errors from before the pool was sized are history rather than a
        regression.
        """
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT job_id, proc_name, err_message "
                "FROM timescaledb_information.job_errors "
                "WHERE start_time > pg_postmaster_start_time() "
                "  AND err_message ILIKE '%failed to start%'"
            )
            failures = cur.fetchall()

        self.assertEqual(
            failures,
            [],
            f"{len(failures)} job(s) could not be given a worker since this server started: "
            f"{failures}",
        )


class DeploymentFilesTestCase(unittest.TestCase):
    """No database needed. The chart must size the pool from its own terms."""

    def test_the_chart_derives_the_pool_rather_than_repeating_it(self):
        """
        The chart must COMPUTE max_worker_processes from the two terms.

        A literal there would be correct on the day it was written and silently wrong the first
        time someone raised `workers.background` for a fleet with more rollups -- which is the one
        change this whole setting exists to survive.
        """
        statefulset = STATEFULSET.read_text(encoding="utf-8")
        self.assertIn(
            "max_worker_processes={{ add1 (add .Values.timescaledb.workers.background "
            ".Values.timescaledb.workers.parallel) }}",
            statefulset,
            "the StatefulSet no longer derives max_worker_processes from workers.background and "
            "workers.parallel.",
        )
        for flag in ("timescaledb.max_background_workers=", "max_parallel_workers="):
            self.assertIn(flag, statefulset, f"the StatefulSet no longer passes {flag}")

    def test_the_defaults_leave_room_for_the_launcher(self):
        """
        The two terms the chart adds up are values, so the default pair is what every install
        starts from. Both must be positive: a zero is a policy that never runs.
        """
        values = VALUES.read_text(encoding="utf-8")
        block = values[values.index("  workers:"):]
        background = int(re.search(r"background:\s*(\d+)", block).group(1))
        parallel = int(re.search(r"parallel:\s*(\d+)", block).group(1))

        self.assertGreater(background, 0)
        self.assertGreater(parallel, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
