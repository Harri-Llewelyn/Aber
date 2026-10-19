"""
How a playback ends: Stop, a stalled worker, and the record it leaves (0191).

    python supabase/migrations/test_playback_stop_and_sweep.py

Requires the Supabase database (54322 by default) and the schema the chain declares.

  * playback_progress() stamps progress_reported_at, and answers stop for a row no longer RUNNING.
  * request_playback_stop() sets the flag on a job whose worker is reporting, and ends a job whose
    worker has been silent for over a minute as CANCELLED, saying how far it had got. The worker's
    playback_finish() then leaves that row alone.

The jobs are written as the owner onto the seeded Playback gateway, then each function is called as
the caller it is meant for. Every test rolls back.
"""
import json
import os
import unittest
import uuid

import psycopg2
from psycopg2 import errors as pg_errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

PLAYBACK_GATEWAY = "16000000-0000-4000-8000-000000000001"
PLAYBACK_WORKER = "b0000000-0000-4000-8000-000000000003"
MANAGER = "00000000-0000-4000-8000-00000000f191"


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' "
                "AND table_name = 'playback_jobs' AND column_name = 'progress_reported_at'"
            )
            if not cur.fetchone():
                raise unittest.SkipTest("0191_a_playback_reports_what_really_happened.sql has not been applied")
        finally:
            conn.close()
        cls.conn = get_connection()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.cur = self.conn.cursor()
        self.cur.execute(
            "INSERT INTO auth.users (id, email) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING",
            (MANAGER, "playback-stop-manager@test.local"),
        )
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id) "
            "SELECT %s, id FROM public.roles WHERE name = 'Shopfloor_Manager' ON CONFLICT DO NOTHING",
            (MANAGER,),
        )
        # Nothing else may be in flight on the target: the one-per-target index.
        self.cur.execute(
            "UPDATE public.playback_jobs SET status = 'FAILED', finished_at = now() "
            "WHERE status IN ('PENDING', 'RUNNING')"
        )

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()

    # -- fixtures, as the owner -----------------------------------------------------------------
    def job(self, status="RUNNING", started_ago="5 seconds", reported_ago=None, sent=0, total=0):
        job_id = str(uuid.uuid4())
        self.cur.execute("RESET ROLE")
        self.cur.execute(
            "INSERT INTO public.playback_jobs (id, capture_storage_path, target_gateway_id, "
            "  target_edge_node_id, sparkplug_group, status, started_at, progress_reported_at, "
            "  messages_sent, messages_total) "
            "SELECT %s, 'dev880000000000400080000/capture.json', id, sparkplug_id, "
            "       coalesce(sparkplug_group, 'Aber'), %s, "
            "       CASE WHEN %s = 'RUNNING' THEN now() - %s::interval END, "
            "       now() - %s::interval, %s, %s "
            "  FROM public.gateways WHERE id = %s",
            (job_id, status, status, started_ago, reported_ago, sent, total, PLAYBACK_GATEWAY),
        )
        self.assertEqual(self.cur.rowcount, 1, "the seeded Playback gateway is missing")
        return job_id

    def row(self, job_id):
        self.cur.execute("RESET ROLE")
        self.cur.execute(
            "SELECT status, stop_requested, error, finished_at IS NOT NULL, progress_reported_at "
            "FROM public.playback_jobs WHERE id = %s", (job_id,))
        return self.cur.fetchone()

    # -- callers ---------------------------------------------------------------------------------
    def as_caller(self, subject):
        self.cur.execute("SET LOCAL ROLE authenticated")
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true)",
                         (json.dumps({"sub": subject, "role": "authenticated"}),))

    def stop(self, job_id):
        self.as_caller(MANAGER)
        self.cur.execute("SELECT public.request_playback_stop(%s)", (job_id,))
        return self.cur.fetchone()[0]

    def progress(self, job_id, sent=1, total=5):
        self.as_caller(PLAYBACK_WORKER)
        self.cur.execute("SELECT public.playback_progress(%s, %s, %s, %s)", (job_id, sent, total, 3))
        return self.cur.fetchone()[0]

    def finish(self, job_id, sent=1, error=None):
        self.as_caller(PLAYBACK_WORKER)
        self.cur.execute("SELECT public.playback_finish(%s, %s, %s, 0)", (job_id, sent, error))


class ProgressTests(Base):
    def test_a_report_stamps_the_time_and_does_not_stop_a_running_job(self):
        job_id = self.job()
        self.assertIs(self.progress(job_id), False)
        self.assertIsNotNone(self.row(job_id)[4])

    def test_a_row_no_longer_running_is_told_to_stop(self):
        job_id = self.job(status="CANCELLED")
        self.assertIs(self.progress(job_id), True)

    def test_only_the_playback_worker_may_report(self):
        job_id = self.job()
        self.as_caller(MANAGER)
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self.cur.execute("SELECT public.playback_progress(%s, 1, 1, 1)", (job_id,))


class StopTests(Base):
    def test_a_reporting_job_only_gets_the_flag(self):
        job_id = self.job(reported_ago="2 seconds")
        self.assertIs(self.stop(job_id), True)
        status, flag, error, finished, _ = self.row(job_id)
        self.assertEqual((status, flag, error, finished), ("RUNNING", True, None, False))

    def test_a_job_silent_for_over_a_minute_is_ended_here(self):
        job_id = self.job(started_ago="10 minutes", reported_ago="147 seconds", sent=4, total=5)
        self.assertIs(self.stop(job_id), True)
        status, flag, error, finished, _ = self.row(job_id)
        self.assertEqual((status, flag, finished), ("CANCELLED", True, True))
        self.assertIn("had not reported for 14", error)
        self.assertIn("4 message(s) published of 5", error)

    def test_a_job_that_never_reported_is_judged_by_its_claim(self):
        job_id = self.job(started_ago="5 minutes", reported_ago=None)
        self.stop(job_id)
        self.assertEqual(self.row(job_id)[0], "CANCELLED")
        fresh = self.job(status="RUNNING", started_ago="5 seconds", reported_ago=None)
        self.stop(fresh)
        self.assertEqual(self.row(fresh)[0], "RUNNING")

    def test_the_worker_coming_back_is_told_to_stop_and_its_finish_changes_nothing(self):
        job_id = self.job(started_ago="10 minutes", reported_ago="5 minutes", sent=2, total=9)
        self.stop(job_id)
        before = self.row(job_id)
        self.assertIs(self.progress(job_id, sent=3, total=9), True)
        self.finish(job_id, sent=3)
        self.assertEqual(self.row(job_id)[:4], before[:4])

    def test_a_queued_job_is_cancelled_outright(self):
        job_id = self.job(status="PENDING", started_ago=None)
        self.stop(job_id)
        self.assertEqual(self.row(job_id)[:3], ("CANCELLED", True, "cancelled before the worker claimed it"))

    def test_a_finished_job_is_not_stopped(self):
        job_id = self.job(status="COMPLETED", started_ago=None)
        self.assertIs(self.stop(job_id), False)


PLAYBACK_GW = "gwy160000000000400080000"
OTHER_GW = "gwy990000000000400080000"


class CredentialSourceTests(Base):
    """playback_report_credential_sources(): which password the worker uses, never the password."""

    def report(self, sources, held=(PLAYBACK_GW,)):
        self.as_caller(PLAYBACK_WORKER)
        self.cur.execute("SELECT public.playback_report_credentials(%s, '{}')", (list(held),))
        self.cur.execute("SELECT public.playback_report_credential_sources(%s::jsonb)",
                         (json.dumps(sources),))
        self.cur.execute("RESET ROLE")
        self.cur.execute("SELECT credential_sources FROM public.playback_worker_status WHERE id")
        return self.cur.fetchone()[0]

    def test_the_order_is_kept_and_only_held_gateways_and_known_names_are_stored(self):
        stored = self.report({PLAYBACK_GW: ["helm", "delivered", "a-password", "helm", 7],
                              OTHER_GW: ["delivered"]})
        self.assertEqual(stored, {PLAYBACK_GW: ["helm", "delivered"]})

    def test_anything_but_an_object_stores_nothing(self):
        self.assertEqual(self.report(["delivered"]), {})

    def test_only_the_playback_worker_may_report(self):
        self.as_caller(MANAGER)
        with self.assertRaises(pg_errors.InsufficientPrivilege):
            self.cur.execute("SELECT public.playback_report_credential_sources('{}'::jsonb)")

    def test_anon_holds_nothing_on_it(self):
        self.cur.execute("RESET ROLE")
        self.cur.execute("SELECT has_function_privilege('anon', "
                         "'public.playback_report_credential_sources(jsonb)', 'EXECUTE')")
        self.assertFalse(self.cur.fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
