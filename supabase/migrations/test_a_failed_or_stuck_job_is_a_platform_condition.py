"""
A failed or stuck capture or playback, and a playback worker that stops reporting while a playback
waits, are platform conditions (0226).

    python supabase/migrations/test_a_failed_or_stuck_job_is_a_platform_condition.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

Each condition is read through the rule Grafana evaluates on it: the rule's own query, read out of
the alert rules file and run against platform_health. What is held:

  * job_failed: a capture and a playback that FAILED in the last hour give one row each, named by
    kind and id. An hour on, the row is gone, so the alert resolves by itself. A completed or
    cancelled job gives none. The workers' failure gates write no Audit Trail row.
  * job_stuck: a queued capture, a recording past its duration cap or silent past two minutes, a
    queued playback with the worker free, and a running playback silent past a minute each give a
    row once five minutes past that; just inside, none. A playback queued behind a running one
    gives none, and so does any playback while the worker's heartbeat is stale.
  * playback_worker_stale: a heartbeat older than two minutes gives a row only while a playback is
    queued or running. With nothing queued it stays silent, the seeded 'epoch' row included.
  * grafana_reader runs each rule's query and reads none of the tables behind it.

Every test rolls back.
"""
import json
import os
import re
import unittest
import uuid
from pathlib import Path

import psycopg2
from psycopg2 import errors, sql

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

REPO = Path(__file__).resolve().parents[2]
RULES = REPO / "grafana" / "provisioning" / "alerting" / "alert-rules.yaml"

PLAYBACK_GATEWAY = "16000000-0000-4000-8000-000000000001"
SERVICE_INGESTOR = "b0000000-0000-4000-8000-000000000002"
SERVICE_PLAYBACK = "b0000000-0000-4000-8000-000000000003"

FAILED = "aber-job-failed"
STUCK = "aber-job-stuck"
STALE = "aber-playback-worker-stale"


def get_connection(user=DB_USER, password=DB_PASSWORD):
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=user, password=password)
    conn.autocommit = False
    return conn


def rule_query(uid):
    """The rawSql of one provisioned rule, as Grafana sends it."""
    text = RULES.read_text(encoding="utf-8")
    rule = text[text.index(f"uid: {uid}\n"):]
    end = rule.find("\n      - uid: ")
    rule = rule if end == -1 else rule[:end]
    block = re.search(r"\n( +)rawSql: \|\n((?:\1  .*\n)+)", rule)
    if not block:
        raise AssertionError(f"{uid} has no rawSql block in the rules file")
    return "\n".join(line[len(block.group(1)) + 2:] for line in block.group(2).splitlines())


def reader_password():
    """The password db-init gives grafana_reader: the environment's, or the one the test chain uses."""
    if os.getenv("BI_READER_PASSWORD"):
        return os.environ["BI_READER_PASSWORD"]
    found = re.search(r"bi_reader_password: '([^']+)'",
                      (REPO / "scripts" / "migration-vars.mjs").read_text(encoding="utf-8"))
    return found.group(1) if found else None


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT prosrc FROM pg_proc WHERE oid = 'public.platform_health_rows()'::regprocedure;")
                if "'job_stuck'::text" not in cur.fetchone()[0]:
                    raise unittest.SkipTest("0226 is not applied to this database")
        finally:
            conn.rollback()
            conn.close()
        cls.queries = {uid: rule_query(uid) for uid in (FAILED, STUCK, STALE)}

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        # Nothing else in flight, and every earlier job ended a day ago, so the rows read here are
        # this test's own. The worker is reporting unless a test says otherwise.
        for table, running in (("capture_jobs", "RECORDING"), ("playback_jobs", "RUNNING")):
            self.cur.execute(sql.SQL(
                "UPDATE public.{} SET status = CASE WHEN status IN ('PENDING', %s) THEN 'FAILED' ELSE status END,"
                "                     finished_at = now() - interval '1 day'"
                " WHERE status IN ('PENDING', %s) OR finished_at IS NULL"
                "    OR finished_at > now() - interval '1 day';"
            ).format(sql.Identifier(table)), (running, running))
        self.heartbeat("10 seconds")
        self.subject = self._gateway(shadow=False)

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # -- fixtures, as the owner -------------------------------------------------------------------

    def _gateway(self, shadow):
        gid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, deployment, is_simulated, is_shadow)"
            " VALUES (%s, %s, 'cell', %s, %s, %s) RETURNING id, sparkplug_id;",
            (gid, f"Test_Job_GW_{gid[:8]}", "host" if shadow else "remote", shadow, shadow),
        )
        return self.cur.fetchone()

    def heartbeat(self, ago):
        """The worker last reported `ago` (an SQL interval), or never ('epoch')."""
        if ago == "epoch":
            self.cur.execute("UPDATE public.playback_worker_status SET reported_at = 'epoch';")
        else:
            self.cur.execute("UPDATE public.playback_worker_status SET reported_at = now() - %s::interval;", (ago,))

    def capture(self, status, created="1 minute", started=None, elapsed=0, max_seconds=300, finished=None,
                error=None):
        """A capture_jobs row; each time is an SQL interval ago."""
        jid = str(uuid.uuid4())
        gid, wire = self.subject
        self.cur.execute(
            "INSERT INTO public.capture_jobs (id, subject_kind, gateway_id, sparkplug_group, edge_node_id,"
            " subject_sparkplug_id, storage_path, status, max_seconds, elapsed_seconds, error, created_at,"
            " started_at, finished_at)"
            " VALUES (%s, 'gateway', %s, 'Aber', %s, %s, %s, %s, %s, %s, %s, now() - %s::interval,"
            "         now() - %s::interval, now() - %s::interval);",
            (jid, gid, wire, wire, f"{wire}/{jid}.json", status, max_seconds, elapsed, error, created,
             started, finished),
        )
        return jid

    def playback(self, status, created="1 minute", started=None, reported=None, finished=None,
                 target=PLAYBACK_GATEWAY, error=None):
        """A playback_jobs row onto a shadow gateway; each time is an SQL interval ago."""
        jid = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.playback_jobs (id, capture_storage_path, target_gateway_id,"
            " target_edge_node_id, sparkplug_group, status, error, created_at, started_at,"
            " progress_reported_at, finished_at)"
            " SELECT %s, 'dev880000000000400080000/capture.json', id, sparkplug_id, 'Aber', %s, %s,"
            "        now() - %s::interval, now() - %s::interval, now() - %s::interval, now() - %s::interval"
            "   FROM public.gateways WHERE id = %s;",
            (jid, status, error, created, started, reported, finished, target),
        )
        self.assertEqual(self.cur.rowcount, 1, "the target gateway is missing")
        return jid

    # -- the rules ---------------------------------------------------------------------------------

    def firing(self, uid):
        """{the `job` label: the value} for every row the rule's own query returns now."""
        self.cur.execute(self.queries[uid])
        names = [d[0] for d in self.cur.description]
        rows = [dict(zip(names, row)) for row in self.cur.fetchall()]
        if uid == STALE:
            return rows
        return {row["job"]: row[names[-1]] for row in rows}

    def as_caller(self, subject):
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                         (json.dumps({"sub": subject, "role": "authenticated"}),))


# -------------------------------------------------------------------------------------------------
class AFailedJob(Base):

    def test_a_failed_capture_and_playback_give_one_row_each_named_by_kind_and_id(self):
        capture = self.capture("FAILED", started="6 minutes", finished="5 minutes", error="upload refused")
        playback = self.playback("FAILED", started="11 minutes", finished="10 minutes", error="no credential")
        firing = self.firing(FAILED)
        self.assertEqual(set(firing), {f"capture job {capture}", f"playback job {playback}"})
        # The value is the seconds since it failed, and the rule fires above zero.
        self.assertAlmostEqual(float(firing[f"capture job {capture}"]), 300, delta=5)
        self.assertAlmostEqual(float(firing[f"playback job {playback}"]), 600, delta=5)

    def test_an_hour_on_the_row_is_gone_so_the_alert_resolves_by_itself(self):
        inside = self.capture("FAILED", started="60 minutes", finished="59 minutes")
        firing = self.firing(FAILED)
        self.assertIn(f"capture job {inside}", firing)
        self.cur.execute("UPDATE public.capture_jobs SET finished_at = now() - interval '61 minutes' WHERE id = %s;",
                         (inside,))
        self.assertNotIn(f"capture job {inside}", self.firing(FAILED))

    def test_a_completed_or_cancelled_job_gives_none(self):
        self.capture("COMPLETED", started="2 minutes", finished="1 minute")
        self.playback("CANCELLED", started="3 minutes", finished="1 minute")
        self.assertEqual(self.firing(FAILED), {})

    def test_the_row_says_what_failed_and_why(self):
        capture = self.capture("FAILED", started="2 minutes", finished="1 minute", error="upload refused")
        self.cur.execute("SELECT detail, sparkplug_id FROM public.platform_health "
                         "WHERE condition = 'job_failed' AND subject = %s;", (f"capture job {capture}",))
        detail, wire = self.cur.fetchone()
        self.assertIn(f"the capture of {self.subject[1]} failed at ", detail)
        self.assertTrue(detail.endswith(": upload refused"))
        self.assertIsNone(wire, "a platform condition names no asset")

    def test_the_failure_gates_write_no_audit_trail_row(self):
        """The job history on the Capture page is a failure's record, not the Audit Trail."""
        capture = self.capture("RECORDING", started="1 minute")
        playback = self.playback("RUNNING", started="1 minute", reported="1 second")
        mentions = ("SELECT count(*) FROM public.audit_trail WHERE entity_id::text IN (%s, %s)"
                    " OR new_data::text LIKE %s OR new_data::text LIKE %s;")
        args = (capture, playback, f"%{capture}%", f"%{playback}%")
        self.cur.execute(mentions, args)
        before = self.cur.fetchone()[0]
        self.as_caller(SERVICE_INGESTOR)
        self.cur.execute("SELECT public.ingest_fail_capture(%s, 'upload refused');", (capture,))
        self.cur.execute("RESET ROLE;")
        self.as_caller(SERVICE_PLAYBACK)
        self.cur.execute("SELECT public.playback_finish(%s, 0, 'no credential', 0);", (playback,))
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT status FROM public.capture_jobs WHERE id = %s UNION ALL "
                         "SELECT status FROM public.playback_jobs WHERE id = %s;", (capture, playback))
        self.assertEqual([r[0] for r in self.cur.fetchall()], ["FAILED", "FAILED"])
        self.cur.execute(mentions, args)
        self.assertEqual(self.cur.fetchone()[0], before)
        self.assertEqual(set(self.firing(FAILED)), {f"capture job {capture}", f"playback job {playback}"})


# -------------------------------------------------------------------------------------------------
class AStuckJob(Base):
    """Five minutes past its own limits, and not a second before."""

    def assert_stuck(self, label, past_limits):
        firing = self.firing(STUCK)
        self.assertIn(label, firing)
        self.assertAlmostEqual(float(firing[label]), past_limits, delta=5)

    def test_a_queued_capture_five_minutes_on(self):
        stuck = self.capture("PENDING", created="5 minutes 10 seconds")
        self.assert_stuck(f"capture job {stuck}", 310)

    def test_a_queued_capture_just_inside_is_not(self):
        self.capture("PENDING", created="4 minutes 50 seconds")
        self.assertEqual(self.firing(STUCK), {})

    def test_a_recording_past_its_duration_cap(self):
        # Reporting until a minute ago, so only the cap has run out: 60 s cap, started 7 minutes ago.
        stuck = self.capture("RECORDING", created="7 minutes", started="7 minutes", elapsed=360, max_seconds=60)
        self.assert_stuck(f"capture job {stuck}", 360)

    def test_a_recording_silent_past_two_minutes(self):
        # A two-hour cap, and no report for seven and a half minutes: limits out at two minutes.
        stuck = self.capture("RECORDING", created="1 hour", started="1 hour", elapsed=3600 - 450, max_seconds=7200)
        self.assert_stuck(f"capture job {stuck}", 330)

    def test_a_recording_that_reports_inside_its_cap_is_not(self):
        self.capture("RECORDING", created="1 hour", started="1 hour", elapsed=3599, max_seconds=7200)
        self.assertEqual(self.firing(STUCK), {})

    def test_a_recording_just_inside_its_margin_is_not(self):
        # The 60 s cap ran out four minutes and fifty seconds ago.
        self.capture("RECORDING", created="5 minutes 50 seconds", started="5 minutes 50 seconds", max_seconds=60)
        self.assertEqual(self.firing(STUCK), {})

    def test_a_queued_playback_with_the_worker_free(self):
        stuck = self.playback("PENDING", created="6 minutes")
        self.assert_stuck(f"playback job {stuck}", 360)

    def test_a_queued_playback_is_timed_from_the_last_playback_to_end(self):
        """A job queued behind another starts its wait when the worker came free."""
        self.playback("COMPLETED", created="1 hour", started="1 hour", finished="4 minutes")
        self.playback("PENDING", created="30 minutes")
        self.assertEqual(self.firing(STUCK), {})

    def test_a_playback_queued_behind_a_running_one_is_not(self):
        other = self._gateway(shadow=True)
        self.playback("RUNNING", created="1 hour", started="1 hour", reported="1 second", target=other[0])
        self.playback("PENDING", created="30 minutes")
        self.assertEqual(self.firing(STUCK), {})

    def test_a_running_playback_silent_past_a_minute(self):
        stuck = self.playback("RUNNING", created="10 minutes", started="10 minutes", reported="6 minutes 30 seconds")
        self.assert_stuck(f"playback job {stuck}", 330)

    def test_a_running_playback_that_never_reported_is_timed_from_its_claim(self):
        stuck = self.playback("RUNNING", created="7 minutes", started="7 minutes")
        self.assert_stuck(f"playback job {stuck}", 360)

    def test_a_running_playback_that_reports_is_not(self):
        self.playback("RUNNING", created="2 hours", started="2 hours", reported="1 second")
        self.assertEqual(self.firing(STUCK), {})

    def test_no_playback_is_stuck_while_the_worker_is_silent(self):
        """One cause, one alert: playback_worker_stale names it."""
        self.heartbeat("10 minutes")
        self.playback("PENDING", created="30 minutes")
        self.assertEqual(self.firing(STUCK), {})
        self.assertEqual(len(self.firing(STALE)), 1)

    def test_a_finished_job_is_never_stuck(self):
        self.capture("COMPLETED", created="3 hours", started="3 hours", finished="2 hours")
        self.playback("CANCELLED", created="3 hours", finished="2 hours")
        self.assertEqual(self.firing(STUCK), {})


# -------------------------------------------------------------------------------------------------
class AStalePlaybackWorker(Base):
    """Only while a playback is queued or running, never from the heartbeat's age alone."""

    def test_silent_with_nothing_queued_even_at_the_seeded_epoch(self):
        for ago in ("10 minutes", "epoch"):
            with self.subTest(heartbeat=ago):
                self.heartbeat(ago)
                self.assertEqual(self.firing(STALE), [])

    def test_a_queued_playback_and_a_heartbeat_over_two_minutes_old(self):
        self.heartbeat("2 minutes 30 seconds")
        self.playback("PENDING", created="10 seconds")
        rows = self.firing(STALE)
        self.assertEqual(len(rows), 1)
        self.assertGreater(float(rows[0]["quiet_seconds"]), 120)

    def test_a_running_playback_counts_as_waiting_too(self):
        self.heartbeat("5 minutes")
        self.playback("RUNNING", created="10 minutes", started="10 minutes", reported="5 minutes")
        self.assertEqual(len(self.firing(STALE)), 1)

    def test_a_worker_that_never_reported_and_a_queued_playback(self):
        """playback.enabled: false, and a job queued through the API: nothing will ever run it."""
        self.heartbeat("epoch")
        self.playback("PENDING", created="10 seconds")
        self.assertEqual(len(self.firing(STALE)), 1)
        self.cur.execute("SELECT detail FROM public.platform_health WHERE condition = 'playback_worker_stale';")
        self.assertEqual(self.cur.fetchone()[0],
                         "the playback worker has never reported, and a playback job is queued or running")

    def test_a_reporting_worker_is_not_stale(self):
        self.heartbeat("1 minute 50 seconds")
        self.playback("PENDING", created="10 seconds")
        self.assertEqual(self.firing(STALE), [])

    def test_a_queued_capture_is_not_the_playback_worker_s(self):
        self.heartbeat("epoch")
        self.capture("PENDING", created="10 seconds")
        self.assertEqual(self.firing(STALE), [])


# -------------------------------------------------------------------------------------------------
class TheReader(Base):

    def test_no_api_role_runs_the_function(self):
        for role in ("anon", "authenticated"):
            self.cur.execute("SELECT has_function_privilege(%s, 'public.platform_health_rows()', 'EXECUTE');", (role,))
            self.assertFalse(self.cur.fetchone()[0], role)

    def test_grafana_reader_runs_each_rule_and_reads_nothing_behind_it(self):
        self.cur.execute("SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader';")
        if not self.cur.fetchone():
            self.skipTest("grafana_reader exists only where BI_READER_PASSWORD is set")
        try:
            reader = get_connection("grafana_reader", reader_password())
        except psycopg2.OperationalError as err:
            self.skipTest(f"cannot sign in as grafana_reader with the test chain's password: {err}")
        try:
            with reader.cursor() as cur:
                for uid, query in self.queries.items():
                    with self.subTest(rule=uid):
                        cur.execute(query)
                        cur.fetchall()
                for table in ("capture_jobs", "playback_jobs", "playback_worker_status"):
                    cur.execute("SAVEPOINT denied;")
                    with self.assertRaises(errors.InsufficientPrivilege, msg=table):
                        cur.execute(sql.SQL("SELECT 1 FROM public.{} LIMIT 1;").format(sql.Identifier(table)))
                    cur.execute("ROLLBACK TO SAVEPOINT denied;")
        finally:
            reader.rollback()
            reader.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
