"""
The Prometheus exposition endpoint (issue #22) and the sequence-gap counters (issue #24).

WHY THESE TWO SUITES ARE ONE FILE. #24 is "increment a counter at a detection site that already
works", and its whole risk is that the counter is exported under a name nothing queries, or that it
fires on one of the two legitimate non-gaps. Both of those are questions about the exposition, so
testing the increment without testing what a scraper sees would leave the interesting half unproven.

NO STACK AND NO BROKER. `render_exposition` is a pure function over a counter snapshot, and the
sequence tests stub protobuf/MQTT/psycopg2 before importing ingestion.py -- the same shape as
test_declared_metrics.py and test_payload_conformance.py, and the reason those run in the unit job
rather than in e2e.

    python ingestion/test_metrics_endpoint.py
"""
import os
import sys
import types
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import metrics  # noqa: E402
import registry  # noqa: E402


# =================================================================================================
# The exposition format
# =================================================================================================
class ExpositionTestCase(unittest.TestCase):
    def lines(self, text):
        return [l for l in text.splitlines() if l and not l.startswith("#")]

    def test_a_flat_counter_becomes_its_mapped_name(self):
        out = metrics.render_exposition({"metrics_written": 42})
        self.assertIn("acs_ingestion_metrics_written_total 42", self.lines(out))

    def test_every_drop_reason_lands_on_one_metric_with_a_reason_label(self):
        """
        THE POINT OF THE LABEL. Four flat names become four series of ONE metric, so
        `sum by (reason) (...)` is a query rather than four hand-maintained panels -- and a drop
        reason added later appears in that sum without anything else changing.
        """
        out = metrics.render_exposition({
            "dropped_gateway_binding": 1,
            "dropped_quarantined_or_unregistered": 2,
            "dropped_directory_unavailable": 3,
            "dropped_db_unavailable": 4,
        })
        for reason, value in [
            ("gateway_binding", 1), ("quarantined_or_unregistered", 2),
            ("directory_unavailable", 3), ("db_unavailable", 4),
        ]:
            self.assertIn(
                f'acs_ingestion_messages_dropped_total{{reason="{reason}"}} {value}',
                self.lines(out),
            )

    def test_every_drop_counter_in_ingestion_is_mapped(self):
        """
        THE CHECK THAT KEEPS THIS FILE HONEST, and the acceptance criterion from #22: "counters
        cover every existing drop path". Read out of the source rather than restated, so a new
        drop reason fails here instead of quietly never being exported.

        IT READS `drop("<reason>")`, NOT `count("dropped_<reason>")`. The two statements were
        merged into one helper so the counter name and the logged `reason` field are derived from
        a single string; the counter is still `dropped_<reason>` and this reconstructs it, which
        is why the assertion below is unchanged. A bare `count("dropped_...")` outside the helper
        is ALSO matched, so a site that opts out of `drop()` is not thereby exempt from export.
        """
        import re
        source = open(
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "ingestion.py"),
            encoding="utf-8",
        ).read()
        dropped = {f"dropped_{r}" for r in re.findall(r'\bdrop\(\s*\n?\s*"([a-z_]+)"', source)}
        dropped |= set(re.findall(r'count\("(dropped_[a-z_]+)"', source))
        self.assertTrue(dropped, "found no drop reasons -- the regex has gone stale")
        for name in dropped:
            self.assertIn(
                name, metrics.COUNTER_MAP,
                f"{name} is counted by ingestion.py but has no Prometheus mapping, so it would "
                f"be invisible to a scraper",
            )

    def test_every_directory_unavailable_drop_path_is_counted(self):
        """
        THE INVERSE ASSERTION, and the defect from #126.

        The check above proves that a counted drop is exported. It cannot prove the thing that
        actually went wrong: four `except DirectoryUnavailable` arms dropped a message and called
        `count()` at none of them, so the daemon reported two drops in a minute it made six. A
        test reading `count("dropped_*")` out of the source can only ever see the sites that are
        already there -- it is blind to the absence.

        So this reads the CONTROL FLOW instead of the strings. Every handler for
        DirectoryUnavailable is a path where a message is being given up on, and every one of
        them must increment something. Structural rather than textual on purpose: a new drop arm
        added in a year fails here on the day it is written, without anyone remembering #126.

        `count()` ANYWHERE IN THE HANDLER SATISFIES THIS, including inside a branch. That is
        deliberate -- process_node_message counts outside its throttle and could reasonably be
        restructured -- and it is the reason the behavioural suite below asserts the increments
        themselves rather than trusting this check alone.
        """
        import ast
        source = open(
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "ingestion.py"),
            encoding="utf-8",
        ).read()

        def catches_directory_unavailable(handler):
            caught = handler.type
            if caught is None:
                return False
            parts = caught.elts if isinstance(caught, ast.Tuple) else [caught]
            return any(getattr(p, "id", None) == "DirectoryUnavailable" for p in parts)

        handlers = [
            node for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.ExceptHandler) and catches_directory_unavailable(node)
        ]
        self.assertTrue(
            handlers, "found no DirectoryUnavailable handlers -- this check has gone stale"
        )

        for handler in handlers:
            # `drop()` COUNTS, so it satisfies this exactly as `count()` does -- it wraps the
            # same registry. Both spellings are accepted rather than only the helper: the point
            # of this check is that the arm increments SOMETHING, and narrowing it to one
            # spelling would start failing arms that are correct.
            counted = any(
                isinstance(call, ast.Call) and getattr(call.func, "id", None) in ("count", "drop")
                for call in ast.walk(handler)
            )
            self.assertTrue(
                counted,
                f"ingestion.py:{handler.lineno} catches DirectoryUnavailable and drops the "
                f"message without calling drop() or count(). The drop is then visible only as a "
                f"WARNING in a log nobody is tailing, and Prometheus reports nothing (#126).",
            )

    def test_a_dropped_birth_is_a_different_series_from_a_dropped_sample(self):
        """
        WHY FOUR REASONS AND NOT ONE. A dropped DDATA is one sample. A dropped DBIRTH takes the
        alias table with it, so every later alias-only message from that node is undecodable
        until the next rebirth. Summed into one `directory_unavailable` series those are
        indistinguishable, and the alert on the birth rate could not be written.
        """
        out = metrics.render_exposition({
            "dropped_directory_unavailable": 1,
            "dropped_dbirth_directory_unavailable": 2,
            "dropped_ddeath_directory_unavailable": 3,
            "dropped_node_message_directory_unavailable": 4,
        })
        for reason, value in [
            ("directory_unavailable", 1), ("dbirth_directory_unavailable", 2),
            ("ddeath_directory_unavailable", 3), ("node_message_directory_unavailable", 4),
        ]:
            self.assertIn(
                f'acs_ingestion_messages_dropped_total{{reason="{reason}"}} {value}',
                self.lines(out),
            )
        # Still one metric family, so `sum by (reason)` -- which the drop alert uses -- picks the
        # three new reasons up with no change to the rule.
        self.assertEqual(1, out.count("# HELP acs_ingestion_messages_dropped_total"))

    def test_an_unmapped_counter_is_surfaced_rather_than_dropped(self):
        """
        A counter with no mapping still appears, under a name that says the mapping is missing.
        Silently discarding it would make a monitoring gap invisible to monitoring.
        """
        out = metrics.render_exposition({"something_new": 7})
        self.assertIn(
            'acs_ingestion_unmapped_counter_total{counter="something_new"} 7', self.lines(out)
        )

    def test_msg_type_is_derived_from_the_existing_per_type_counters(self):
        # ingestion.py already writes `messages_<type>`; the dimension costs nothing at the site.
        out = metrics.render_exposition({"messages_ddata": 10, "messages_nbirth": 2})
        self.assertIn('acs_ingestion_messages_total{msg_type="ddata"} 10', self.lines(out))
        self.assertIn('acs_ingestion_messages_total{msg_type="nbirth"} 2', self.lines(out))

    def test_the_flat_total_is_not_exported_beside_the_labelled_series(self):
        """
        `messages_total` is the SUM of the per-type counters. Exporting both would give a scraper
        two ways to count the same message, and `sum(acs_ingestion_messages_total)` -- the obvious
        query -- would silently double.
        """
        out = metrics.render_exposition({"messages_total": 12, "messages_ddata": 12})
        self.assertNotIn("acs_ingestion_messages_total 12", self.lines(out))
        self.assertEqual(
            1, len([l for l in self.lines(out) if l.startswith("acs_ingestion_messages_total")])
        )

    def test_help_and_type_appear_once_per_metric(self):
        """
        A HARD REQUIREMENT OF THE FORMAT, not a nicety: repeating HELP for a metric is a parse
        error in strict scrapers and silently drops series in lenient ones. Four series of one
        metric must still carry one header pair.
        """
        out = metrics.render_exposition({
            "dropped_gateway_binding": 1, "dropped_db_unavailable": 1,
            "dropped_directory_unavailable": 1, "dropped_quarantined_or_unregistered": 1,
        })
        self.assertEqual(1, out.count("# HELP acs_ingestion_messages_dropped_total"))
        self.assertEqual(1, out.count("# TYPE acs_ingestion_messages_dropped_total"))

    def test_gauges_are_typed_as_gauges(self):
        out = metrics.render_exposition({}, gauges={"acs_ingestion_db_connected": 0})
        self.assertIn("# TYPE acs_ingestion_db_connected gauge", out)
        self.assertIn("acs_ingestion_db_connected 0", self.lines(out))

    def test_a_label_value_cannot_break_the_line(self):
        """
        Edge node ids come off the wire. A quote or backslash in one would otherwise produce a
        line no scraper can parse -- and it would take the whole scrape with it, not just that
        series.
        """
        out = metrics.render_exposition(
            {}, labelled={("acs_ingestion_sequence_gaps_total", (("edge_node", 'a"b\\c'),)): 1}
        )
        self.assertIn(
            'acs_ingestion_sequence_gaps_total{edge_node="a\\"b\\\\c"} 1', self.lines(out)
        )

    def test_a_labelled_gauge_is_typed_as_a_gauge(self):
        """
        THE TYPE COMES FROM THE NAME, NOT FROM WHICH ARGUMENT THE SERIES ARRIVED ON. `gauges` takes
        no label dimension, so the cache occupancy series has to come in through `labelled` -- and
        it would silently export as a counter if TYPES were consulted only for `gauges` entries.
        A counter that goes down is a scraper reporting a reset, so the wrong type here would turn
        an ordinary eviction into a fabricated spike on every rate() over it.
        """
        out = metrics.render_exposition(
            {}, labelled={("acs_ingestion_cache_entries", (("cache", "device"),)): 17}
        )
        self.assertIn("# TYPE acs_ingestion_cache_entries gauge", out)
        self.assertIn('acs_ingestion_cache_entries{cache="device"} 17', self.lines(out))

    def test_the_eviction_counter_stays_a_counter(self):
        # It only ever rises, and "the cap was hit N times" is exactly a rate() question.
        out = metrics.render_exposition(
            {}, labelled={("acs_ingestion_cache_evictions_total", (("cache", "device"),)): 3}
        )
        self.assertIn("# TYPE acs_ingestion_cache_evictions_total counter", out)

    def test_every_exported_metric_carries_help(self):
        # An unhelped metric renders, but a reader meeting it in Grafana has nothing to go on.
        out = metrics.render_exposition(
            {name: 1 for name in metrics.COUNTER_MAP},
            gauges={"acs_ingestion_up": 1, "acs_ingestion_db_connected": 1},
        )
        for line in out.splitlines():
            if line.startswith("# TYPE "):
                metric = line.split()[2]
                self.assertIn(metric, metrics.HELP, f"{metric} has no HELP text")

    def test_output_ends_with_a_newline(self):
        # Required by the format; some scrapers discard the final sample without it.
        self.assertTrue(metrics.render_exposition({"metrics_written": 1}).endswith("\n"))

    def test_an_empty_registry_still_renders(self):
        # A daemon that has seen nothing must still answer 200 with a parseable body, or a healthy
        # quiet stack is indistinguishable from a broken exporter.
        self.assertEqual("\n", metrics.render_exposition({}))


# =================================================================================================
# The endpoint
# =================================================================================================
class EndpointTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = metrics.start_metrics_server(
            0, lambda: metrics.render_exposition({"metrics_written": 5})
        )
        # Port 0 asks the OS for a free one, so parallel runs cannot collide.
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close()

    def get(self, path):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}") as r:
            return r.status, r.headers.get("Content-Type"), r.read().decode()

    def test_metrics_is_served_with_the_prometheus_content_type(self):
        status, ctype, body = self.get("/metrics")
        self.assertEqual(200, status)
        self.assertIn("text/plain", ctype)
        self.assertIn("version=0.0.4", ctype)
        self.assertIn("acs_ingestion_metrics_written_total 5", body)

    def test_it_needs_no_credential(self):
        # Asserted rather than assumed, because it decides what may ever appear on this endpoint.
        status, _, _ = self.get("/metrics")
        self.assertEqual(200, status)

    def test_an_unknown_path_is_404_rather_than_an_empty_200(self):
        """
        A handler that answered everything would make a typo in a scrape config look like a
        working target serving no metrics -- which reads as an idle component.
        """
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.get("/metricz")
        self.assertEqual(404, ctx.exception.code)

    def test_a_failing_collector_does_not_take_the_process_down(self):
        def boom():
            raise RuntimeError("counter registry unavailable")

        server = metrics.start_metrics_server(0, boom)
        try:
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(
                    f"http://127.0.0.1:{server.server_address[1]}/metrics"
                )
            self.assertEqual(500, ctx.exception.code)
        finally:
            server.shutdown(); server.server_close()

    def test_a_port_that_cannot_be_bound_returns_None_rather_than_raising(self):
        """
        A port already in use is a monitoring problem. Refusing to start the daemon over it would
        turn a missing graph into an outage.

        THE BIND IS MADE TO FAIL DIRECTLY, not by occupying a port first. `HTTPServer` sets
        `allow_reuse_address`, and what that means is PLATFORM-SPECIFIC: on Linux it permits only
        a socket in TIME_WAIT, so a second bind fails; on Windows it permits taking over a live
        one, so the second bind SUCCEEDS. A test written the obvious way passes in CI and fails on
        a developer's machine, having asserted nothing about the branch either way.
        """
        real = metrics.HTTPServer

        def refuse(*_args, **_kwargs):
            raise OSError(98, "Address already in use")

        metrics.HTTPServer = refuse
        try:
            self.assertIsNone(metrics.start_metrics_server(9999, lambda: ""))
        finally:
            metrics.HTTPServer = real

    def test_port_zero_is_ephemeral_rather_than_a_way_to_disable(self):
        """
        The disable switch is a CONFIGURATION decision and lives in
        ingestion.start_metrics_endpoint(). Overloading 0 here would make the mechanism
        untestable -- a test cannot ask for a free port without it -- which is how this suite
        found the ambiguity in the first place.
        """
        server = metrics.start_metrics_server(0, lambda: "")
        try:
            self.assertIsNotNone(server)
            self.assertGreater(server.server_address[1], 0)
        finally:
            server.shutdown(); server.server_close()


# =================================================================================================
# Sequence gaps (#24), against the real check_message_sequence
# =================================================================================================
def _load_ingestion():
    """
    Import ingestion.py with its I/O dependencies stubbed.

    Same approach as test_declared_metrics.py: the module opens no connection at import time, but
    it does import psycopg2, paho and the generated protobuf, none of which need to be present to
    exercise a pure sequence check.
    """
    for name in ("psycopg2", "psycopg2.extras", "paho", "paho.mqtt", "paho.mqtt.client"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.modules["psycopg2"].extras = sys.modules["psycopg2.extras"]
    sys.modules["psycopg2.extras"].execute_values = lambda *a, **k: None
    sys.modules["psycopg2"].connect = lambda *a, **k: None
    sys.modules["paho.mqtt.client"].Client = object
    if "sparkplug_b_pb2" not in sys.modules:
        sys.modules["sparkplug_b_pb2"] = types.ModuleType("sparkplug_b_pb2")
    os.environ.setdefault("SUPABASE_URL", "http://localhost")
    os.environ.setdefault("SUPABASE_PUBLISHABLE_KEY", "test")
    os.environ.setdefault("SUPABASE_INGESTION_KEY", "test")
    import ingestion
    return ingestion


class _Payload:
    """The two protobuf accessors check_message_sequence uses."""

    def __init__(self, seq):
        self._seq = seq

    def HasField(self, name):  # noqa: N802 - protobuf's interface
        return name == "seq" and self._seq is not None

    @property
    def seq(self):
        return self._seq


class SequenceGapTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ing = _load_ingestion()

    def setUp(self):
        self.ing._last_seq.clear()
        registry._labelled.clear()
        # request_node_rebirth needs a broker client; None is the documented "no client" path and
        # is what keeps this test off the network.
        self.node = "TestNode"

    def gaps(self, node=None):
        key = ("acs_ingestion_sequence_gaps_total", (("edge_node", node or self.node),))
        return self.ing.labelled_snapshot().get(key, 0)

    def missed(self, node=None):
        key = ("acs_ingestion_sequence_messages_missed_total", (("edge_node", node or self.node),))
        return self.ing.labelled_snapshot().get(key, 0)

    def send(self, seq, msg_type="DDATA"):
        return self.ing.check_message_sequence("G", self.node, msg_type, _Payload(seq), None)

    def test_a_gap_increments_both_counters(self):
        self.send(41)
        self.assertFalse(self.send(43))          # 42 never arrived
        self.assertEqual(1, self.gaps())
        self.assertEqual(1, self.missed())

    def test_the_missed_count_is_the_size_of_the_gap(self):
        """
        One gap of 200 and 200 gaps of 1 are different faults -- a single broker reconnect against
        a gateway dropping messages continuously. This is what separates them.
        """
        self.send(10)
        self.send(211)
        self.assertEqual(1, self.gaps())
        self.assertEqual(200, self.missed())

    def test_the_255_to_0_wrap_is_not_a_gap(self):
        # `seq` wraps by specification. Counting it would fire on every node every 256 messages.
        self.send(255)
        self.assertTrue(self.send(0))
        self.assertEqual(0, self.gaps())

    def test_the_first_message_after_a_restart_is_not_a_gap(self):
        # No baseline: the daemon started mid-run. Counting it would fire at every node on every
        # deploy, which is exactly the noise that makes an alert ignored.
        self.assertTrue(self.send(137))
        self.assertEqual(0, self.gaps())

    def test_an_nbirth_resynchronises_rather_than_counting(self):
        self.send(10)
        self.assertTrue(self.send(0, msg_type="NBIRTH"))
        self.assertEqual(0, self.gaps())

    def test_a_redelivered_message_is_not_a_gap(self):
        # QoS-1 redelivery repeats a seq already seen. The broker doing its job, not a loss.
        self.send(5)
        self.assertTrue(self.send(5))
        self.assertEqual(0, self.gaps())

    def test_ndeath_is_excluded(self):
        # It carries bdSeq, not a live seq, and is published when the node is already gone.
        self.send(5)
        self.assertTrue(self.send(200, msg_type="NDEATH"))
        self.assertEqual(0, self.gaps())

    def test_gaps_are_attributed_per_edge_node(self):
        """
        A single flapping gateway must be distinguishable from plant-wide loss -- which is the
        whole reason for the label, and why it is the edge node rather than the device.
        """
        self.send(1)
        self.node = "OtherNode"
        self.send(1)
        self.send(9)
        self.assertEqual(0, self.gaps("TestNode"))
        self.assertEqual(1, self.gaps("OtherNode"))

    def test_the_advisory_behaviour_is_unchanged(self):
        """
        #24 adds a counter and must not change ingestion semantics. The gap still returns False,
        and the daemon still resyncs rather than latching -- so one drop does not become a
        permanent alarm.
        """
        self.send(41)
        self.assertFalse(self.send(43))
        # Resynced to 43, so 44 is in sequence.
        self.assertTrue(self.send(44))
        self.assertEqual(1, self.gaps())

    def test_the_counters_render_under_the_names_the_alert_rules_use(self):
        self.send(1)
        self.send(5)
        out = metrics.render_exposition({}, labelled=self.ing.labelled_snapshot())
        self.assertIn(f'acs_ingestion_sequence_gaps_total{{edge_node="{self.node}"}} 1', out)
        self.assertIn(
            f'acs_ingestion_sequence_messages_missed_total{{edge_node="{self.node}"}} 3', out
        )


# =================================================================================================
# The historian write latency histogram
#
# WHY THIS IS TESTED HARDER THAN THE COUNTERS. A counter that renders wrongly is obviously wrong --
# a wrong number in a place a human reads. A histogram that renders wrongly still LOOKS like a
# histogram: Prometheus ingests it, the panels draw, and histogram_quantile() returns a number that
# is simply not the quantile. There is no error anywhere in that chain, so the only place the
# mistake can be caught is here.
# =================================================================================================
class HistogramRenderingTestCase(unittest.TestCase):
    METRIC = "acs_ingestion_write_seconds"

    def render(self, buckets, total, total_sum=1.0):
        return metrics.render_exposition(
            {}, histograms={self.METRIC: {"buckets": buckets, "sum": total_sum, "count": total}}
        )

    def bucket_labels(self, out):
        """The `le` values in the order they were EMITTED, which is the property under test."""
        found = []
        for line in out.splitlines():
            if line.startswith(f"{self.METRIC}_bucket{{le="):
                found.append(line.split('"')[1])
        return found

    def sample(self, out, suffix, le=None):
        want = (
            f'{self.METRIC}_{suffix}{{le="{le}"}} ' if le is not None
            else f"{self.METRIC}_{suffix} "
        )
        for line in out.splitlines():
            if line.startswith(want):
                return line[len(want):]
        self.fail(f"no {want.strip()} sample in:\n{out}")

    # ---------------------------------------------------------------------------------------
    # The ordering trap
    # ---------------------------------------------------------------------------------------
    def test_emitted_bucket_order_is_numeric_not_lexical(self):
        """
        THE ONE THAT WOULD CATCH THE REGRESSION. render_exposition orders a normal metric's
        samples by their label items, which compares STRINGS: lexically "10.0" sorts before "2.5"
        and "+Inf" sorts before every digit, because '+' is 0x2B and '0' is 0x30. Routing buckets
        through that path yields a histogram Prometheus accepts and answers wrong quantiles from.

        So this asserts two things at once: that the emitted order is numerically increasing, and
        that it is NOT the lexical order -- the second half is what makes the first half a real
        test rather than one that would pass under the bug.
        """
        buckets = tuple((b, 1) for b in (0.001, 0.0025, 2.5, 10.0))
        emitted = self.bucket_labels(self.render(buckets, 4))

        self.assertEqual(["0.001", "0.0025", "2.5", "10.0", "+Inf"], emitted)

        numeric = [float("inf") if v == "+Inf" else float(v) for v in emitted]
        self.assertEqual(sorted(numeric), numeric, "buckets are not in increasing `le` order")
        self.assertNotEqual(
            sorted(emitted), emitted,
            "this fixture no longer distinguishes lexical from numeric order, so it would pass "
            "even if buckets were routed back through the shared sorting path"
        )

    def test_the_real_bucket_boundaries_also_defeat_a_lexical_sort(self):
        """
        The test above proves the renderer; this proves the CONFIGURATION is one the renderer's
        guarantee matters for. WRITE_SECONDS_BUCKETS spans 0.001 to 10.0, and a set whose lexical
        and numeric orders happened to agree would make the property untested in practice.
        """
        ing = _load_ingestion()
        labels = [repr(float(b)) for b in ing.WRITE_SECONDS_BUCKETS] + ["+Inf"]
        self.assertNotEqual(sorted(labels), labels)

    # ---------------------------------------------------------------------------------------
    # Cumulativeness
    # ---------------------------------------------------------------------------------------
    def test_buckets_accumulate(self):
        # Per-bucket 1,2,3 is cumulative 1,3,6 -- `le` means "less than or equal to", so a bucket
        # that reported only its own count would understate every quantile.
        out = self.render(((0.001, 1), (0.01, 2), (0.1, 3)), 6)
        self.assertEqual("1", self.sample(out, "bucket", "0.001"))
        self.assertEqual("3", self.sample(out, "bucket", "0.01"))
        self.assertEqual("6", self.sample(out, "bucket", "0.1"))

    def test_inf_equals_count(self):
        # Prometheus requires this exactly; a mismatch is a malformed histogram.
        out = self.render(((0.001, 1), (0.01, 2)), 3)
        self.assertEqual(self.sample(out, "count"), self.sample(out, "bucket", "+Inf"))

    def test_an_observation_above_the_top_boundary_is_only_in_inf(self):
        """
        An 11-second write increments no finite bucket. It must still appear, or the series that
        exists to expose stalls would hide the worst one it ever saw.
        """
        out = self.render(((0.001, 1), (10.0, 0)), 2, total_sum=11.5)
        self.assertEqual("1", self.sample(out, "bucket", "10.0"))
        self.assertEqual("2", self.sample(out, "bucket", "+Inf"))
        self.assertEqual("11.5", self.sample(out, "sum"))

    # ---------------------------------------------------------------------------------------
    # Format
    # ---------------------------------------------------------------------------------------
    def test_boundaries_render_exactly_and_never_in_scientific_notation(self):
        # "2.5e-03" is a different label value from "0.0025", so a scrape that changed format
        # mid-life would silently start a NEW series and break every rate() across the boundary.
        self.assertEqual("0.0025", metrics._format_le(0.0025))
        self.assertEqual("+Inf", metrics._format_le(float("inf")))
        for boundary in _load_ingestion().WRITE_SECONDS_BUCKETS:
            self.assertNotIn("e", metrics._format_le(boundary))

    def test_type_is_histogram_and_help_is_present(self):
        out = self.render(((0.001, 1),), 1)
        self.assertIn(f"# TYPE {self.METRIC} histogram", out)
        self.assertIn(f"# HELP {self.METRIC} ", out)
        self.assertIn(self.METRIC, metrics.HELP)

    def test_the_help_and_type_pair_appears_once_for_the_whole_family(self):
        # _bucket, _sum and _count are one metric family. A HELP line before each suffix is a
        # parse error in strict scrapers -- the same rule the counter path already observes.
        out = self.render(((0.001, 1), (0.01, 1)), 2)
        self.assertEqual(1, out.count(f"# TYPE {self.METRIC} "))
        self.assertEqual(1, out.count(f"# HELP {self.METRIC} "))

    def test_absent_histograms_change_nothing(self):
        # The parameter is optional, so every existing caller and every existing test keeps its
        # exact output.
        self.assertEqual("\n", metrics.render_exposition({}))
        self.assertEqual("\n", metrics.render_exposition({}, histograms={}))


class WriteLatencyRegistryTestCase(unittest.TestCase):
    """observe_write_seconds itself, against the real module."""

    def setUp(self):
        self.ing = _load_ingestion()
        # Module-level state, so each test starts from a known point rather than from whatever
        # the previous one left.
        with registry._counters_lock:
            registry._write_seconds_buckets[:] = [0] * len(registry.WRITE_SECONDS_BUCKETS)
            registry._write_seconds_sum = 0.0
            registry._write_seconds_count = 0

    def snapshot(self):
        return self.ing.histogram_snapshot()["acs_ingestion_write_seconds"]

    def test_an_observation_lands_in_the_lowest_bucket_that_contains_it(self):
        self.ing.observe_write_seconds(0.003)
        landed = [b for b, n in self.snapshot()["buckets"] if n]
        # 0.003 is above 0.0025 and at or below 0.005.
        self.assertEqual([0.005], landed)

    def test_a_boundary_value_lands_in_its_own_bucket_not_the_next(self):
        # `le` is inclusive. An observation of exactly 0.01 belongs to le="0.01".
        self.ing.observe_write_seconds(0.01)
        self.assertEqual([0.01], [b for b, n in self.snapshot()["buckets"] if n])

    def test_sum_and_count_track_every_observation_including_outliers(self):
        for v in (0.001, 0.5, 99.0):
            self.ing.observe_write_seconds(v)
        snap = self.snapshot()
        self.assertEqual(3, snap["count"])
        self.assertAlmostEqual(99.501, snap["sum"], places=6)
        # 99.0 exceeds every boundary, so the finite buckets hold only two of the three.
        self.assertEqual(2, sum(n for _, n in snap["buckets"]))

    def test_the_reconnect_stall_is_readable_off_the_top_buckets(self):
        """
        DB_CONNECT_MAX_ATTEMPTS * DB_CONNECT_BACKOFF_SECONDS is the stall the whole fleet waits
        behind, and the bucket boundaries were chosen so it cannot hide inside a bucket that also
        holds healthy writes. A healthy local insert and a reconnect must not share a bucket.
        """
        worst = self.ing.DB_CONNECT_MAX_ATTEMPTS * self.ing.DB_CONNECT_BACKOFF_SECONDS
        self.assertGreaterEqual(worst, 0.25, "backoff no longer reaches the bucket it was sized for")
        self.ing.observe_write_seconds(0.002)          # healthy
        self.ing.observe_write_seconds(worst)          # a full reconnect
        landed = [b for b, n in self.snapshot()["buckets"] if n]
        self.assertEqual(2, len(landed))
        self.assertLess(landed[0], 0.25)
        self.assertGreaterEqual(landed[1], 0.25)

    def test_it_renders_through_the_endpoint_path(self):
        self.ing.observe_write_seconds(0.004)
        out = metrics.render_exposition({}, histograms=self.ing.histogram_snapshot())
        self.assertIn('acs_ingestion_write_seconds_bucket{le="0.005"} 1', out)
        self.assertIn("acs_ingestion_write_seconds_count 1", out)


# =================================================================================================
# The four uncounted drop paths (#126), against the real process_* functions
#
# The structural check in ExpositionTestCase proves each handler calls count(). It cannot prove
# the call is REACHED, that it names the counter the mapping expects, or that the throttle on the
# node path does not swallow it. That is what these do: drive the real function with a directory
# that is unavailable and read the counter a scraper would see.
# =================================================================================================
class DirectoryUnavailableDropTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ing = _load_ingestion()

    def setUp(self):
        registry._counters.clear()
        self.ing._unknown_gateway_warned.clear()
        # The daemon returns early on every one of these paths when there is no client, so a
        # falsy one would make all four tests pass against code that never ran.
        self._saved = {
            name: getattr(self.ing, name)
            for name in ("supabase_client", "resolve_device", "resolve_gateway",
                         "verify_gateway_binding", "register_birth_aliases")
        }
        self.ing.supabase_client = object()
        self.ing.register_birth_aliases = lambda *a, **k: None

    def tearDown(self):
        for name, value in self._saved.items():
            setattr(self.ing, name, value)

    def unavailable(self, *a, **k):
        raise self.ing.DirectoryUnavailable("directory is down")

    def counter(self, name):
        return self.ing.counter_snapshot().get(name, 0)

    def test_a_dbirth_dropped_before_registration_is_counted(self):
        self.ing.resolve_device = self.unavailable
        self.ing.process_dbirth("dev-1", "node-a", _Payload(None))
        self.assertEqual(1, self.counter("dropped_dbirth_directory_unavailable"))

    def test_a_dbirth_abandoned_part_way_through_is_counted(self):
        """The second birth arm: the directory answered, then went away inside the binding check."""
        self.ing.resolve_device = lambda *a, **k: {
            "id": "d1", "sparkplug_id": "dev-1", "is_quarantined": False,
            "_identity_source": self.ing.SOURCE_REPORTED_IDENTITY,
        }
        self.ing.verify_gateway_binding = self.unavailable
        self.ing.process_dbirth("dev-1", "node-a", _Payload(None))
        self.assertEqual(1, self.counter("dropped_dbirth_directory_unavailable"))

    def test_a_dropped_ddeath_is_counted_separately_from_a_birth(self):
        self.ing.resolve_device = self.unavailable
        self.ing.process_ddeath("dev-1", "node-a")
        self.assertEqual(1, self.counter("dropped_ddeath_directory_unavailable"))
        self.assertEqual(0, self.counter("dropped_dbirth_directory_unavailable"))

    def test_a_dropped_node_message_is_counted(self):
        self.ing.resolve_gateway = self.unavailable
        self.ing.process_node_message("node-a", "NDEATH", _NodePayload())
        self.assertEqual(1, self.counter("dropped_node_message_directory_unavailable"))

    def test_the_node_counter_is_not_throttled_with_the_warning(self):
        """
        THE REASON THAT COUNTER SITS OUTSIDE THE `if`. A heartbeat arrives every 30s and the
        warning is rate-limited to one per UNKNOWN_GATEWAY_WARN_INTERVAL_SECONDS. A counter
        sharing that guard would report one drop per window however many messages were lost --
        an undercount of exactly the kind #126 is about, reintroduced one level down.
        """
        self.ing.resolve_gateway = self.unavailable
        for _ in range(5):
            self.ing.process_node_message("node-a", "NDEATH", _NodePayload())
        self.assertEqual(5, self.counter("dropped_node_message_directory_unavailable"))

    def test_the_counters_reach_the_exposition_under_their_mapped_names(self):
        """
        End to end: the increment the daemon makes is the series a scraper reads. Both halves
        have their own test above; this is the one that fails if they drift apart.
        """
        self.ing.resolve_device = self.unavailable
        self.ing.process_dbirth("dev-1", "node-a", _Payload(None))
        out = metrics.render_exposition(self.ing.counter_snapshot())
        self.assertIn(
            'acs_ingestion_messages_dropped_total{reason="dbirth_directory_unavailable"} 1',
            [l for l in out.splitlines() if l and not l.startswith("#")],
        )


class _NodePayload:
    """process_node_message iterates payload.metrics before resolving the gateway."""

    metrics = []


if __name__ == "__main__":
    unittest.main(verbosity=2)
