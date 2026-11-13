# suite:
#   lanes: unit
#   why: The playback worker's metrics endpoint: one series, aber_playback_jobs_total{outcome}, with
#     failed, cancelled and completed at zero from startup and no other label value, so an
#     unauthenticated port carries no id. Each outcome is counted once the finish is recorded, as
#     playback_finish() ranks them, and the startup sweep counts what it failed. Without it a failed
#     playback leaves no trace in Prometheus.

"""
The playback worker's metrics endpoint, and the outcome count it serves.

    python ingestion/test_playback_metrics.py

No broker, no database and no stack. What this suite holds:

  * THE ENDPOINT SERVES ONE SERIES, `aber_playback_jobs_total{outcome}`, with failed, cancelled and
    completed each present at zero from startup and no `_created` series. It has no credential, so
    it serves a count and nothing else. Only /metrics and / answer, and port 0 disables it.
  * EACH OUTCOME IS COUNTED ONCE THE DATABASE HAS RECORDED IT, as playback_finish() records it: an
    error is failed, a stop cancelled, anything else completed. A job whose end was never recorded
    is not counted. The jobs the startup sweep fails are counted failed.
  * THE LABEL'S VALUES ARE THE STATUSES playback_finish() WRITES, read from the last declaration in
    the migration chain.

check-docs-drift check 192 holds the chart to the worker: the port's variable, the scrape
annotations and the network policy's edge.
"""
import importlib
import os
import re
import sys
import unittest
import unittest.mock
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

INGESTION_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, INGESTION_DIR)

from prometheus_client.parser import text_string_to_metric_families  # noqa: E402

import metrics  # noqa: E402
import playback_worker  # noqa: E402

MIGRATIONS = Path(INGESTION_DIR).parent / "supabase" / "migrations"
FAMILY = "aber_playback_jobs_total"
GW = "gwy160000000000400080000"
JOB_ID = "00000000-0000-4000-8000-0000000000dd"


def counted(outcome):
    return playback_worker.METRICS.get_sample_value(FAMILY, {"outcome": outcome})


def counts():
    return {outcome: counted(outcome) for outcome in playback_worker.OUTCOMES}


class Done(BaseException):
    """Ends main()'s loop from a fake, past its `except Exception`."""


class FakeSupabase:
    """Every RPC answers from `answers[name](params)`, or with no data."""

    def __init__(self, **answers):
        self.calls = []
        self.answers = answers

    def rpc(self, name, params):
        def execute():
            self.calls.append(name)
            answer = self.answers.get(name)
            return SimpleNamespace(data=answer(params) if answer else None)
        return SimpleNamespace(execute=execute)


class FakeClock:
    """time.monotonic(), time.time() and time.sleep() for the worker, advancing only on sleep."""

    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now

    def time(self):
        return 1_760_000_000.0 + self.now

    def sleep(self, seconds):
        self.now += seconds


# -------------------------------------------------------------------------------------------------
# The exposition
# -------------------------------------------------------------------------------------------------
class TheExposition(unittest.TestCase):

    def families(self):
        return {f.name: f for f in text_string_to_metric_families(playback_worker.render_metrics())}

    def test_every_outcome_is_present_at_zero_from_startup(self):
        # A fresh module is a fresh process: a counter born at its first event shows rate() nothing.
        importlib.reload(playback_worker)
        self.assertEqual(counts(), {"failed": 0.0, "cancelled": 0.0, "completed": 0.0})

    def test_it_serves_one_counter_family_and_nothing_else(self):
        families = self.families()
        # The parser names a counter family without its _total suffix.
        self.assertEqual(list(families), ["aber_playback_jobs"])
        family = families["aber_playback_jobs"]
        self.assertEqual(family.type, "counter")
        self.assertTrue(family.documentation.strip())
        self.assertEqual(sorted(s.labels["outcome"] for s in family.samples),
                         sorted(playback_worker.OUTCOMES))
        self.assertEqual({s.name for s in family.samples}, {FAMILY})

    def test_no_created_series(self):
        self.assertNotIn("_created", playback_worker.render_metrics())

    def test_each_label_is_one_of_three_values_never_an_id(self):
        for sample in self.families()["aber_playback_jobs"].samples:
            self.assertEqual(set(sample.labels), {"outcome"})
            self.assertIn(sample.labels["outcome"], ("failed", "cancelled", "completed"))

    def test_an_outcome_outside_the_set_is_refused_and_counts_nothing(self):
        before = counts()
        with self.assertRaises(ValueError):
            playback_worker.count_outcome("stuck")
        with self.assertRaises(ValueError):
            playback_worker.count_outcome(JOB_ID)
        self.assertEqual(counts(), before)

    def test_the_outcomes_are_the_statuses_playback_finish_records(self):
        """Lower-cased, so a query reads the Capture page's words."""
        needle = "CREATE OR REPLACE FUNCTION public.playback_finish("
        body = None
        for name in sorted(f for f in os.listdir(MIGRATIONS) if re.match(r"^\d{4}_.*\.sql$", f)):
            text = (MIGRATIONS / name).read_text(encoding="utf-8")
            at = text.rfind(needle)
            if at >= 0:
                body = text[at:text.index("$$;", at)]
        self.assertIsNotNone(body, "no applied migration declares playback_finish()")
        statuses = set(re.findall(r"'(FAILED|CANCELLED|COMPLETED)'", body))
        self.assertEqual({o.upper() for o in playback_worker.OUTCOMES}, statuses)


# -------------------------------------------------------------------------------------------------
# The endpoint
# -------------------------------------------------------------------------------------------------
class TheEndpoint(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        # Port 0 is the OS's choice of free port in metrics.py, as everywhere in the socket API.
        cls.server = metrics.start_metrics_server(0, playback_worker.render_metrics)
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=5) as response:
            return response.status, response.headers.get("Content-Type"), response.read().decode()

    def test_metrics_is_served_in_the_prometheus_text_format(self):
        status, content_type, body = self.get("/metrics")
        self.assertEqual(status, 200)
        self.assertTrue(content_type.startswith("text/plain; version=0.0.4"))
        self.assertIn('aber_playback_jobs_total{outcome="failed"}', body)

    def test_any_other_path_is_a_404(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/healthz")
        self.assertEqual(caught.exception.code, 404)

    def test_port_zero_disables_it(self):
        with unittest.mock.patch.object(playback_worker, "PLAYBACK_METRICS_PORT", 0), \
                unittest.mock.patch.object(playback_worker, "start_metrics_server") as serve, \
                self.assertLogs(playback_worker.logger, level="INFO") as logs:
            self.assertIsNone(playback_worker.start_metrics_endpoint())
        serve.assert_not_called()
        self.assertIn("Metrics endpoint disabled (PLAYBACK_METRICS_PORT=0)", "\n".join(logs.output))

    def test_the_configured_port_serves_the_worker_s_own_registry(self):
        with unittest.mock.patch.object(playback_worker, "PLAYBACK_METRICS_PORT", 9109), \
                unittest.mock.patch.object(playback_worker, "start_metrics_server") as serve:
            playback_worker.start_metrics_endpoint()
        serve.assert_called_once_with(9109, playback_worker.render_metrics, playback_worker.logger)

    def test_the_default_port_is_the_chart_s(self):
        values = (Path(INGESTION_DIR).parent / "deploy" / "helm" / "aber" / "values.yaml").read_text(encoding="utf-8")
        playback = values[values.index("\nplayback:\n"):]
        port = re.search(r"\n  metrics:\n    enabled: \w+\n    port: (\d+)\n", playback)
        self.assertIsNotNone(port, "values.yaml has no playback.metrics.port")
        source = Path(playback_worker.__file__).read_text(encoding="utf-8")
        default = re.search(r'os\.getenv\("PLAYBACK_METRICS_PORT", "(\d+)"\)', source)
        self.assertEqual(default.group(1), port.group(1))


# -------------------------------------------------------------------------------------------------
# What main() counts
# -------------------------------------------------------------------------------------------------
class TheOutcomeCount(unittest.TestCase):
    """main() against a fake PostgREST, with the job's run replaced by what each case needs."""

    def setUp(self):
        self.started = []
        patches = {
            "_storage": lambda: None,
            "_start_heartbeat": lambda holdings: None,
            "_credential_sources": lambda: {GW: [("delivered", "a-password")]},
            "SUPABASE_PLAYBACK_KEY": "a-key",
            "start_metrics_endpoint": lambda: self.started.append("metrics"),
            "time": FakeClock(),
        }
        for name, value in patches.items():
            patcher = unittest.mock.patch.object(playback_worker, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def main(self, run=None, **answers):
        """One pass of main(): the sweep, one job run by `run`, its finish, then Done."""
        claims = iter([{"id": JOB_ID, "target_edge_node_id": GW, "speed": 1.0,
                        "capture_storage_path": GW + "/capture.json", "device_map": {}}])

        def claim(_params):
            try:
                return next(claims)
            except StopIteration:
                raise Done()

        answers.setdefault("playback_claim_job", claim)
        supabase = FakeSupabase(**answers)

        def sweep_then_record(params):
            self.started.append("sweep")
            return answers.get("playback_reconcile_jobs", lambda _p: 0)(params)

        supabase.answers["playback_reconcile_jobs"] = sweep_then_record
        with unittest.mock.patch.object(playback_worker, "_supabase", lambda: supabase), \
                unittest.mock.patch.object(playback_worker, "_run_job",
                                           run or (lambda s, st, c, job, outcome=None: (3, 0, None))):
            before = counts()
            with self.assertRaises(Done):
                playback_worker.main()
        after = counts()
        return {o: after[o] - before[o] for o in after}

    def test_a_job_that_ran_to_its_end_is_completed(self):
        self.assertEqual(self.main(), {"failed": 0, "cancelled": 0, "completed": 1})

    def test_a_job_that_ended_with_an_error_is_failed(self):
        def failed(supabase, storage, credentials, job, outcome=None):
            return 2, 0, "publishing stopped after 2 message(s): the broker connection was lost"
        self.assertEqual(self.main(failed), {"failed": 1, "cancelled": 0, "completed": 0})

    def test_a_job_the_operator_stopped_is_cancelled(self):
        def stopped(supabase, storage, credentials, job, outcome=None):
            outcome["stopped"] = True
            return 2, 0, None
        self.assertEqual(self.main(stopped), {"failed": 0, "cancelled": 1, "completed": 0})

    def test_an_error_outranks_a_stop_as_playback_finish_ranks_them(self):
        def both(supabase, storage, credentials, job, outcome=None):
            outcome["stopped"] = True
            return 2, 0, "the primary host 'aber-ingestion' went offline after 2 message(s)"
        self.assertEqual(self.main(both), {"failed": 1, "cancelled": 0, "completed": 0})

    def test_an_unhandled_error_in_the_job_is_failed(self):
        def boom(supabase, storage, credentials, job, outcome=None):
            raise RuntimeError("a bug")
        with self.assertLogs(playback_worker.logger, level="ERROR"):
            delta = self.main(boom)
        self.assertEqual(delta, {"failed": 1, "cancelled": 0, "completed": 0})

    def test_a_job_whose_end_was_never_recorded_is_not_counted(self):
        """The row stays RUNNING; Stop or the next start's sweep ends it, and the sweep counts it."""
        def refuse(_params):
            raise ConnectionError("PGRST002: schema cache not loaded")
        with self.assertLogs(playback_worker.logger, level="ERROR"):
            delta = self.main(playback_finish=refuse)
        self.assertEqual(delta, {"failed": 0, "cancelled": 0, "completed": 0})

    def test_the_jobs_the_startup_sweep_failed_are_counted_failed(self):
        delta = self.main(playback_reconcile_jobs=lambda _p: 2)
        self.assertEqual(delta, {"failed": 2, "cancelled": 0, "completed": 1})

    def test_the_endpoint_is_served_before_the_sweep(self):
        self.main()
        self.assertEqual(self.started[:2], ["metrics", "sweep"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
