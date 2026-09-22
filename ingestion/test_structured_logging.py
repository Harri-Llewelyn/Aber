"""
Structured logging, and the drop pair it exists to make queryable.

WHAT THIS FILE IS ACTUALLY GUARDING. metrics.py's header states a property the daemon was built
around: "the counters and the log cannot disagree about what happened". Prometheus holds one half
of every drop -- that one happened, and how many. The half naming WHICH device, under WHICH edge
node, exists only in the warning beside it. The log store keeps that half; this suite is
about making it a FIELD rather than a sentence, so a store can be asked "which devices dropped on
gateway_binding last night" without a regex over prose.

THE INTERESTING ASSERTION IS THE ONE ABOUT AGREEMENT. `drop()` derives the counter name and the
logged `reason` from one string, so the two cannot drift -- and the source checks below read the
reasons back out of ingestion.py to prove the set is complete rather than restated here.

NO STACK AND NO BROKER: the formatters are pure, and the source checks are textual. Same shape as
test_metrics_endpoint.py, and the reason this runs in the unit job.

    python ingestion/test_structured_logging.py
"""
import io
import os
import re
import sys
import ast
import json
import logging
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import metrics  # noqa: E402
import logging_config  # noqa: E402

# The collector's config lives in the chart template; the River is a YAML block scalar there,
# so the regexes below read it as text.
ALLOY_TEMPLATE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "deploy", "helm", "aber",
    "templates", "obs", "alloy.yaml")

INGESTION_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ingestion.py")


def build(formatter, name):
    """A logger writing into a buffer, bypassing get_logger's env reading and handler caching."""
    logger = logging.Logger(name)
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    return logger, buf


# =================================================================================================
# The JSON formatter
# =================================================================================================
class JSONFormatterTestCase(unittest.TestCase):
    def emit(self, *args, **kwargs):
        logger, buf = build(logging_config.JSONFormatter(), "j")
        logger.warning(*args, **kwargs)
        return json.loads(buf.getvalue())

    def test_extra_fields_are_promoted_to_top_level(self):
        """
        TOP LEVEL, NOT NESTED. `reason` is the key every drop query starts from; one level down
        makes the common query the awkward one, for a tidiness nothing benefits from.
        """
        rec = self.emit("dropped", extra={"reason": "gateway_binding", "device": "press-01"})
        self.assertEqual("gateway_binding", rec["reason"])
        self.assertEqual("press-01", rec["device"])

    def test_the_envelope_wins_a_collision_with_a_caller_field(self):
        """
        `ts`, `level` and `logger` are OURS, not logging's, so nothing stops a caller passing
        them via `extra=`. A line whose `level` says something other than the level it was
        emitted at is worse than a lost field, so the envelope is written last and wins.
        """
        rec = self.emit("x", extra={"level": "DEBUG", "ts": "not-a-time"})
        self.assertEqual("WARNING", rec["level"])
        self.assertNotEqual("not-a-time", rec["ts"])

    def test_the_message_is_rendered_not_left_as_a_format_string(self):
        """A store holding `%s` and an args array would be unreadable and unsearchable."""
        rec = self.emit("Dropping DDATA for '%s'", "press-01")
        self.assertEqual("Dropping DDATA for 'press-01'", rec["msg"])
        self.assertNotIn("%s", rec["msg"])

    def test_one_line_per_record(self):
        """A store splits on newlines. A pretty-printed object would arrive as eight records."""
        logger, buf = build(logging_config.JSONFormatter(), "j-lines")
        logger.warning("a", extra={"reason": "db_unavailable"})
        logger.warning("b", extra={"reason": "gateway_binding"})
        self.assertEqual(2, len(buf.getvalue().strip().splitlines()))

    def test_an_unserialisable_field_does_not_take_down_the_daemon(self):
        """
        The field is being logged BECAUSE something is already wrong. Raising here would turn a
        dropped message into a dead ingestion daemon.
        """
        rec = self.emit("x", extra={"err": object()})
        self.assertIn("object", rec["err"])

    def test_an_exception_is_carried_as_a_field(self):
        try:
            raise ValueError("boom")
        except ValueError:
            rec = self.emit("failed", exc_info=True)
        self.assertIn("ValueError: boom", rec["exc"])


# =================================================================================================
# The text formatter -- the half that is easy to forget
# =================================================================================================
class TextFormatterTestCase(unittest.TestCase):
    def emit(self, *args, **kwargs):
        logger, buf = build(
            logging_config.UTCFormatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"), "t")
        logger.warning(*args, **kwargs)
        return buf.getvalue()

    def test_text_mode_carries_the_same_fields_as_json(self):
        """
        THE PROPERTY THAT KEEPS THE TWO MODES HONEST. If text dropped the extras, a developer
        reading `docker logs` would see strictly less than the store holds, and would be
        debugging a different record from the one that was kept.
        """
        out = self.emit("dropped", extra={"reason": "gateway_binding", "device": "press-01"})
        self.assertIn("reason=gateway_binding", out)
        self.assertIn("device=press-01", out)

    def test_the_fields_precede_the_traceback(self):
        """
        Appended after the exception, `[reason=...]` reads as the last line of the traceback --
        which is why this is done in formatMessage rather than in format.
        """
        try:
            raise ValueError("boom")
        except ValueError:
            out = self.emit("failed", exc_info=True, extra={"reason": "db_unavailable"})
        self.assertLess(out.index("reason=db_unavailable"), out.index("Traceback"))

    def test_a_line_with_no_extras_is_unchanged(self):
        """The existing format is what every runbook and incident note quotes."""
        out = self.emit("Plain line").strip()
        self.assertTrue(out.endswith("Plain line"), out)
        self.assertRegex(out, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \[WARNING\] t: ")


# =================================================================================================
# Selection, and why the default is what it is
# =================================================================================================
class FormatSelectionTestCase(unittest.TestCase):
    def get(self, name, **env):
        saved = {k: os.environ.get(k) for k in ("LOG_FORMAT", "LOG_LEVEL")}
        os.environ.pop("LOG_FORMAT", None)
        os.environ.update(env)
        try:
            logging.Logger.manager.loggerDict.pop(name, None)
            return logging_config.get_logger(name).handlers[0].formatter
        finally:
            for k, v in saved.items():
                os.environ.pop(k, None)
                if v is not None:
                    os.environ[k] = v

    def test_the_default_is_text(self):
        """
        NOT AN OVERSIGHT, AND NOT THE SAME CLAIM AS "the stack logs text". The chart sets
        `LOG_FORMAT=json` explicitly on ingestion and playback. This default serves the case it
        does not cover: someone running the daemon by
        hand, who is reading with their eyes rather than with a query.

        The assertion is worth keeping precisely because the deployments now override it. If the
        code default moved to json, a local run would start emitting one-line objects and the
        person debugging would have no idea why.
        """
        self.assertIsInstance(self.get("sel-default"), logging_config.UTCFormatter)

    def test_json_is_selected_by_the_env_var(self):
        self.assertIsInstance(
            self.get("sel-json", LOG_FORMAT="json"), logging_config.JSONFormatter)

    def test_a_typo_falls_back_to_text_rather_than_failing(self):
        """A misspelled env var must not silently stop the logs being readable."""
        self.assertIsInstance(
            self.get("sel-typo", LOG_FORMAT="jsonn"), logging_config.UTCFormatter)


# =================================================================================================
# The pair -- read out of ingestion.py rather than restated
# =================================================================================================
class DropPairTestCase(unittest.TestCase):
    def source(self):
        return open(INGESTION_PY, encoding="utf-8").read()

    def reasons(self):
        found = set(re.findall(r'\bdrop\(\s*\n?\s*"([a-z_]+)"', self.source()))
        self.assertTrue(found, "found no drop() reasons -- this check has gone stale")
        return found

    def test_every_reason_a_site_can_emit_is_exported(self):
        """
        THE COUNTER NAME IS DERIVED, NOT TYPED. `drop("gateway_binding")` increments
        `dropped_gateway_binding`, so a reason with no mapping in COUNTER_MAP would be counted
        and never scraped. Read from the source so a new reason fails on the day it is added.
        """
        for reason in self.reasons():
            self.assertIn(
                f"dropped_{reason}", metrics.COUNTER_MAP,
                f'drop("{reason}") has no Prometheus mapping and would be invisible to a scraper',
            )

    def test_the_logged_field_and_the_prometheus_label_are_the_same_string(self):
        """
        THE WHOLE POINT OF §12, AS AN ASSERTION. A panel showing a spike in
        `acs_ingestion_messages_dropped_total{reason="gateway_binding"}` is a drill-down into a
        log store only if the LINES carry that same string. If the label and the field could
        differ, the drill-down would be a second guess at what to search for.
        """
        for reason in self.reasons():
            _, labels = metrics.COUNTER_MAP[f"dropped_{reason}"]
            self.assertEqual(
                reason, labels.get("reason"),
                f'drop("{reason}") logs reason="{reason}" but is exported as '
                f'reason="{labels.get("reason")}" -- the panel and the log disagree',
            )

    def test_no_drop_site_counts_without_logging_its_reason(self):
        """
        The regression this forecloses is a `count("dropped_...")` creeping back in beside a bare
        `logger.warning`. That is the shape §12 exists to retire: the counter says a drop
        happened, and nothing durable says which device it happened to.
        """
        stragglers = re.findall(r'count\("(dropped_[a-z_]+)"', self.source())
        self.assertEqual(
            [], stragglers,
            f"{stragglers} bypass drop(), so the reason is counted but not carried as a field",
        )

    def test_a_throttled_site_throttles_the_log_and_never_the_counter(self):
        """
        THE ONE ASYMMETRY, AND IT IS DELIBERATE. Six sites suppress their warning because the
        traffic arrives on its own cadence -- a heartbeat every 30s, or a retired machine that
        was never unplugged -- and the log would be unreadable. The COUNTER must still fire
        per message, or the metric reports one drop per throttle window instead of one per
        message -- so `emit_log` gates the line only, and this asserts no site can quietly
        throttle by skipping the count instead.
        """
        tree = ast.parse(self.source())
        calls = [n for n in ast.walk(tree)
                 if isinstance(n, ast.Call) and getattr(n.func, "id", None) == "drop"]
        self.assertTrue(calls, "found no drop() calls -- this check has gone stale")
        throttled = [c for c in calls if any(kw.arg == "emit_log" for kw in c.keywords)]
        self.assertEqual(
            6, len(throttled),
            "the number of throttled drop sites changed; confirm the counter still fires per "
            "message at the new one before updating this number",
        )
        for call in throttled:
            kw = next(k for k in call.keywords if k.arg == "emit_log")
            self.assertNotIsInstance(
                kw.value, ast.Constant,
                f"ingestion.py:{call.lineno} passes a constant emit_log; a site that never logs "
                f"is a drop with no durable record of which device it hit",
            )


# =================================================================================================
# The collector's multiline regex, which is coupled to the formatters above and to nothing else
# =================================================================================================
class MultilineFirstlineTestCase(unittest.TestCase):
    """
    THE COUPLING NOBODY WOULD LOOK FOR. The collector (the chart's obs/alloy.yaml) rejoins the
    runtime's one-entry-per-line output into whole records by matching lines that START one --
    `^(\{|\d{4}-\d{2}-\d{2}T)`, which is to say a JSON object or this file's ISO 8601 timestamp.

    That regex is a restatement, in another language and another repository directory, of what
    UTCFormatter and JSONFormatter emit. Change the timestamp format here and the collector goes
    on matching the old shape: every log line becomes a continuation of the one before it, records
    merge into each other, and NOTHING FAILS -- the pipeline stays green while the store fills
    with garbage. test_log_pipeline.py cannot catch it either, because it can only check a
    traceback the stack happened to produce.

    So this reads the regex out of the collector config and applies it to what the formatters
    actually produce.
    """

    @classmethod
    def setUpClass(cls):
        cls.alloy = open(ALLOY_TEMPLATE, encoding="utf-8").read()
        m = re.search(r'firstline\s*=\s*"((?:[^"\\]|\\.)*)"', cls.alloy)
        assert m, "no `firstline` in the chart's alloy.yaml -- this check has gone stale"
        # The config is River, which escapes backslashes the same way a Python string literal
        # does, so the captured text needs one round of unescaping to become the actual pattern.
        cls.firstline = re.compile(m.group(1).encode().decode("unicode_escape"))

    def emitted(self, formatter):
        logger, buf = build(formatter, f"ml-{id(formatter)}")
        logger.warning("Dropping DDATA for '%s'", "press-01",
                       extra={"reason": "gateway_binding", "device": "press-01"})
        return buf.getvalue().splitlines()[0]

    def test_it_matches_a_json_line(self):
        self.assertRegex(self.emitted(logging_config.JSONFormatter()), self.firstline)

    def test_it_matches_a_text_line(self):
        """Both formats must start a record. The stack runs json; a developer runs text, and a
        collector pointed at a text stream must not merge every line into the first one."""
        fmt = logging_config.UTCFormatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
        self.assertRegex(self.emitted(fmt), self.firstline)

    def test_the_stage_is_confined_to_the_services_this_regex_describes(self):
        """
        THE REGEX IS ONLY CORRECT FOR TWO SERVICES, so the stage must only see two services.

        `stage.multiline` opens a block when a line matches `firstline` and then appends every
        following non-matching line to it -- measured, not assumed. Applied to a stream whose
        format this repository does not control, one line that happens to start with `{` or an ISO
        date swallows up to 200 unrelated lines after it, filed under the wrong timestamp. Several
        Supabase components emit JSON some of the time, so that was reachable in normal operation
        and would have looked like lines going missing rather than like an error.

        A stream where NOTHING matches is left alone, which is why mosquitto and node-exporter
        looked unaffected when this was first checked -- an observation that proved nothing and
        nearly closed the question.
        """
        block = re.search(r"stage\.match\s*\{(.*?)stage\.multiline", self.alloy, re.S)
        self.assertTrue(
            block,
            "stage.multiline is no longer wrapped in a stage.match. It would then apply to every "
            "collected service, and this file's regex describes only logging_config.py's formats.",
        )
        # The selector is a River string containing ESCAPED quotes -- `"{service=~\"a|b\"}"` -- so
        # a naive `"([^"]*)"` stops at the first `\"` and captures `{service=~\`, which matches
        # nothing and fails with a message about the wrong thing.
        selector = re.search(r'selector\s*=\s*"((?:[^"\\]|\\.)*)"', block.group(1))
        self.assertTrue(selector, "the stage.match has no selector")
        for service in ("ingestion", "playback"):
            self.assertIn(service, selector.group(1),
                          f"{service} emits these formats but is outside the multiline selector")

    def test_it_does_NOT_match_a_traceback_continuation(self):
        """
        The half that makes the rule useful. If these matched, each line of a traceback would
        start its own record and the exception would arrive as eight fragments -- which is the
        behaviour stage.multiline exists to prevent.
        """
        for line in ('Traceback (most recent call last):',
                     '  File "/app/ingestion.py", line 2960, in process_ddata',
                     '    supabase_client.rpc("record_ingestion_rejection", {',
                     'ValueError: boom'):
            self.assertNotRegex(line, self.firstline)


# =================================================================================================
# The drill-down link, and the three files that have to agree for it to resolve
# =================================================================================================
class DrillDownLinkTestCase(unittest.TestCase):
    """
    THE LINK CROSSES THREE FILES IN THREE LANGUAGES AND NOTHING ELSE CHECKS IT.

    The drop panel on `Stack & Ingestion Health` carries a data link into the log store. For a
    click on it to land on the right lines, all of these must hold at once:

        obs/alloy.yaml        labels streams with `service`
        ingestion.py          logs a `reason` field
        the panel             selects `{service="..."}` and filters on `reason`

    Any one of them can be changed alone, in a file whose other reviewers have no cause to look at
    the other two, and the failure is silent: the link opens Explore, the query is valid, and it
    returns no rows. "No logs" and "wrong label" look identical from the browser.
    """

    @classmethod
    def setUpClass(cls):
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
        cls.dash_path = os.path.join(
            root, "grafana", "provisioning", "dashboards", "platform",
            "stack-ingestion-health.json")
        cls.alloy = open(ALLOY_TEMPLATE, encoding="utf-8").read()
        cls.dash = json.load(open(cls.dash_path, encoding="utf-8"))

    def link(self):
        for panel in self.dash["panels"]:
            if panel.get("title") == "Messages Dropped by Reason":
                links = panel["fieldConfig"]["defaults"].get("links", [])
                self.assertTrue(links, "the drop panel has no data link, so there is no drill-down")
                return links[0]["url"]
        self.fail("no 'Messages Dropped by Reason' panel -- the drill-down has no origin")

    def test_the_panel_selects_a_label_the_collector_actually_sets(self):
        """
        The stream selector in the link must name a label the collector relabels TO. Selecting
        on one it does not set gives a valid query over zero streams.
        """
        selector = re.search(r'\{(\w+)=', self.link().replace('\\', ''))
        self.assertTrue(selector, "the drill-down link has no stream selector")
        label = selector.group(1)
        targets = set(re.findall(r'target_label\s*=\s*"(\w+)"', self.alloy))
        self.assertIn(
            label, targets,
            f'the panel selects {{{label}="..."}} but the collector sets only {sorted(targets)}. '
            f"The link would open a valid query over no streams, which reads as 'no logs'.",
        )

    def test_the_panel_filters_on_the_field_the_daemon_logs(self):
        """
        `reason` is the string the counter label and the log field share. If the link filtered on
        anything else, the drill-down would be a second guess at what to search for -- which is
        the thing deriving both from one `drop()` argument was meant to end.
        """
        url = self.link().replace('\\', '')
        self.assertIn("| json", url, "the link does not parse the line, so no field filter can match")
        self.assertRegex(url, r'reason\s*=', "the link does not filter on `reason`")

    def test_the_link_carries_the_series_reason_rather_than_a_fixed_one(self):
        """
        `${__field.labels.reason}` is what makes ONE link serve all ten reasons. Hardcoding one
        would silently send every click to the same query -- correct-looking, and wrong for nine
        of the ten series on the panel.
        """
        self.assertIn(
            "${__field.labels.reason}", self.link(),
            "the drill-down does not interpolate the clicked series' reason",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
