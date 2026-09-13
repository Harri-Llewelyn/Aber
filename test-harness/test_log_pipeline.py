"""
The log pipeline, end to end, against a running stack.

WHAT THIS ASSERTS THAT NOTHING ELSE CAN. `ingestion/test_structured_logging.py` proves the daemon
FORMATS the fields and that the counter name and the logged `reason` are derived from one string.
That is a property of the source. It cannot prove the claim the store was built for:

    a drop that happens is countable in Prometheus AND readable in Loki, under the same reason,
    naming the device -- through a real broker, a real daemon, a real collector and a real store.

Four processes and two independent stores have to agree for that to hold, and every one of them
can break while the others stay internally consistent. The first live run of this pipeline is the
argument for testing it here: the socket proxy refused one API path, discovery failed WHOLESALE,
and nothing collected anything -- while the container stayed healthy, the healthcheck stayed
green, `alloy validate` passed and every static check in this repository still reported PASS.

HOW THE DROP IS CAUSED, and it is a real one rather than an injected line. A DDATA is published
for a well-formed but unregistered device id, exactly as `validate.py` does. The daemon resolves
it, finds nothing, and takes the `quarantined_or_unregistered` arm -- one of the ten `drop()`
sites. A FRESH RANDOM ID PER RUN is not tidiness: the daemon caches negative lookups, so a fixed
id would be answered from cache on the second run of the day and drop nothing at all.

    python test-harness/test_log_pipeline.py

Needs the stack up, and reads MQTT_VALIDATOR_USER / MQTT_VALIDATOR_PASSWORD from `.env` for the
same reason validate.py does: the ingestion principal may not publish DDATA, so connecting as it
would have every publish discarded by the broker's ACL, silently.
"""
import os
import sys
import json
import time
import shlex
import secrets
import unittest
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ingestion"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stack_exec  # noqa: E402  -- the probe pod

LOKI = os.getenv("LOKI_TEST_URL", "http://127.0.0.1:3100")
PROM = os.getenv("PROMETHEUS_TEST_URL", "http://127.0.0.1:9090")
MQTT_HOST = os.getenv("MQTT_TEST_HOST", "127.0.0.1")
MQTT_PORT = int(os.getenv("MQTT_TEST_PORT", "1883"))
GROUP = "ACS-Cymru"

# The reason this suite drives. One of the ten in ingestion.py, chosen because it is reachable
# with a single publish and needs no fixture: an unregistered device is refused by definition.
REASON = "quarantined_or_unregistered"

# How long to wait for a line to travel daemon -> Docker -> Alloy -> Loki. Alloy's discovery
# refresh is 15s and its batch wait is a few seconds on top, so this is deliberately generous:
# a flaky timeout here would be read as a broken pipeline, which is the opposite of useful.
PROPAGATION_TIMEOUT = 90


# THE FLAG THAT TURNS A SKIP INTO A FAILURE, and the reason it exists is the reason this suite
# is worth running at all.
#
# Every guard below is a legitimate skip when a person runs this by hand with no stack: reporting
# a broken pipeline because Loki is not running would be noise. In CI none of those conditions is
# legitimate -- the stack is up by construction and `.env` is sourced by the step -- and a
# fully-skipped unittest run reports `OK (skipped=N)` and exits 0.
#
# That is the trap the workflow already names at REQUIRE_SEEDED_ACCOUNTS, on suites covering a
# secrecy boundary, and it applies with the same force here: the three assertions that matter most
# depend on a broker credential, and without it they would disappear silently from a green run.
# The flag makes their absence a failure, because where it is set the absence is a fault.
REQUIRE = os.getenv("REQUIRE_LOG_PIPELINE") == "1"


def skip_or_fail(testcase, message):
    """Skip when a human is running this ad hoc; fail where the conditions are guaranteed."""
    if REQUIRE:
        raise AssertionError(
            f"REQUIRE_LOG_PIPELINE=1, so this cannot be skipped: {message}"
        )
    raise unittest.SkipTest(message)


def get_json(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.load(r)


def loki_query(expr, since_seconds=600, limit=50):
    q = urllib.parse.urlencode({
        "query": expr,
        "start": f"{int((time.time() - since_seconds) * 1e9)}",
        "limit": str(limit),
    })
    return get_json(f"{LOKI}/loki/api/v1/query_range?{q}")["data"]["result"]


def prom_query(expr):
    q = urllib.parse.urlencode({"query": expr})
    return get_json(f"{PROM}/api/v1/query?{q}")["data"]["result"]


def prom_scalar(expr, default=0.0):
    r = prom_query(expr)
    return float(r[0]["value"][1]) if r else default


def setUpModule():
    """
    SKIP ONLY WHEN THERE IS NO STACK AT ALL, and fail rather than skip once there is one.

    The CI job that runs this lane names the trap directly: a fully-skipped unittest run reports
    `OK (skipped=N)` and exits 0, which is a green tick over nothing. So the guard below is
    narrow -- it skips when the two stores are unreachable, which means "no stack", and lets
    every other failure be a failure.
    """
    for name, url in (("Loki", f"{LOKI}/ready"), ("Prometheus", f"{PROM}/-/ready")):
        try:
            urllib.request.urlopen(url, timeout=5).read()
        except Exception as exc:
            message = (f"{name} is not reachable at {url} ({exc}). This suite needs the stack up: "
                       f"npm run dev:up")
            if REQUIRE:
                raise AssertionError(f"REQUIRE_LOG_PIPELINE=1, so this cannot be skipped: {message}")
            raise unittest.SkipTest(message)


class CollectionTestCase(unittest.TestCase):
    """The collector is running and shipping. The cheap checks, which fail first and loudest."""

    def test_the_collector_is_scraped_and_up(self):
        """
        If this fails, the two alert rules that depend on this target are also blind. The scrape
        job matters as much as the collector: `loki` and `alloy` were unscraped for the first day
        this store existed, which made the pair whose failure destroys the record of itself the
        only pair with no record of its own.
        """
        self.assertEqual(1.0, prom_scalar('up{job="alloy"}'),
                         "alloy is not up, or prometheus is not scraping it")
        self.assertEqual(1.0, prom_scalar('up{job="loki"}'),
                         "loki is not up, or prometheus is not scraping it")

    def test_the_collector_has_shipped_something(self):
        """`sent > 0` is the whole-pipeline smoke test, and is what the Stalled alert watches."""
        self.assertGreater(
            prom_scalar("sum(loki_write_sent_entries_total)"), 0,
            "the collector has shipped no entries at all -- discovery is the usual cause, and it "
            "fails wholesale rather than partially when the socket proxy refuses an API path",
        )

    def test_no_ceiling_is_currently_biting(self):
        """
        `rate_limited` and `stream_limited` are the two bounds loki.yaml sets by name. Non-zero
        means lines are being LOST right now -- and on a test stack it almost certainly means a
        label was promoted that should have stayed a field, which is the cardinality mistake the
        collector config exists to prevent.

        `ingester_error` is deliberately not asserted on: it counts the benign "entry too far
        behind" refusals from a first attach to already-running containers.
        """
        for reason in ("rate_limited", "stream_limited"):
            self.assertEqual(
                0.0,
                prom_scalar(f'sum(loki_write_dropped_entries_total{{reason="{reason}"}})'),
                f"the log store is refusing lines ({reason}); they are being lost",
            )

    def test_the_services_that_matter_are_being_collected(self):
        """
        `ingestion` because it is the drop half of §12. `mosquitto` because the SECOND argument
        for the store is docs/incidents.md's first entry -- a broker password truncated in one
        container and only visible from another -- and a store that collects the daemon but not
        the broker cannot answer that question at all.
        """
        found = set(get_json(f"{LOKI}/loki/api/v1/label/service/values")["data"] or [])
        for service in ("ingestion", "mosquitto"):
            self.assertIn(service, found,
                          f"no logs collected from '{service}'; collected: {sorted(found)}")

    def test_the_daemon_ships_json_that_loki_can_parse(self):
        """
        The `| json` stage is what every field query depends on, and it silently matches nothing
        against a text line. This is the check that catches `LOG_FORMAT` not being set on the
        deployment -- which is not hypothetical: the daemon ran for a while with the variable set
        and the old image, emitting text with `LOG_FORMAT=json` in its environment.
        """
        rows = loki_query('{service="ingestion"} | json | logger = "ingestion"', limit=5)
        self.assertTrue(
            rows,
            "no ingestion line parsed as JSON with a `logger` field. Either LOG_FORMAT is not "
            "json on the running container, or the image predates logging_config.py's "
            "JSONFormatter -- `npm run dev:up --only=ingestion` rebuilds and restarts it",
        )


class DropPairTestCase(unittest.TestCase):
    """
    THE SUITE'S REASON FOR EXISTING. A real drop, counted in one store and readable in the other,
    under the same reason and naming the device.
    """

    @classmethod
    def setUpClass(cls):
        try:
            import paho.mqtt.client as mqtt
            from validate import make_sparkplug_payload
        except ImportError as exc:
            skip_or_fail(cls, f"paho-mqtt or the payload builder is unavailable ({exc})")

        user = os.getenv("MQTT_VALIDATOR_USER")
        password = os.getenv("MQTT_VALIDATOR_PASSWORD")

        # BOTH, NOT JUST THE PASSWORD, AND THE USERNAME IS THE ONE THAT FAILS QUIETLY.
        #
        # The broker's roles grant each gateway `spBv1.0/+/+/<sparkplug_id>/#` -- the edge-node segment of the
        # topic must equal the username. Checking only the password let an unset username through
        # as `""`, publishing to `.../DDATA/validator/<dev>` on a connection authenticated as
        # nobody. The broker accepts the CONNECT and silently discards the PUBLISH: an ACL refusal
        # is per-message and carries no acknowledgement, so paho reports success. The suite then
        # waited a minute and failed pointing at the daemon, which had never been sent anything.
        missing = [n for n, v in (("MQTT_VALIDATOR_USER", user),
                                  ("MQTT_VALIDATOR_PASSWORD", password)) if not v]
        if missing:
            skip_or_fail(cls,
                f"{' and '.join(missing)} not set. This publisher connects as its own gateway, and "
                "the ingestion principal may not publish DDATA, so there is no fallback -- an "
                "incomplete credential means every publish is discarded by the broker's ACL "
                "WITHOUT an error, and this suite would blame the daemon for a message it never "
                "received. Source the stack's .env.")

        # `dev` + 21 hex, matching validate.py's UNKNOWN_DEVICE_ID shape. RANDOM PER RUN because
        # the daemon caches negative resolutions: a fixed id is answered from cache on a second
        # run and drops nothing, so the suite would pass while testing nothing.
        cls.device = "dev" + secrets.token_hex(11)[:21]

        cls.before = prom_scalar(
            f'sum(acs_ingestion_messages_dropped_total{{reason="{REASON}"}})')

        client = mqtt.Client(protocol=mqtt.MQTTv5)
        client.username_pw_set(user or "", password)
        try:
            client.connect(MQTT_HOST, MQTT_PORT, 30)
        except Exception as exc:
            skip_or_fail(cls, f"cannot reach the broker at {MQTT_HOST}:{MQTT_PORT} ({exc})")
        client.loop_start()

        now_ms = int(time.time() * 1000)
        payload = make_sparkplug_payload(cls.device, {"Systems/TEMPERATURE": 99.9}, now_ms)
        # THE EDGE-NODE SEGMENT IS THE USERNAME, because the broker's roles match them against each
        # other (`spBv1.0/+/+/<sparkplug_id>/#`). It is `user` rather than a re-read with a fallback: the
        # fallback was how a mismatch became possible in the first place.
        client.publish(f"spBv1.0/{GROUP}/DDATA/{user}/{cls.device}", payload)
        time.sleep(3)
        client.loop_stop()
        client.disconnect()

    def test_the_drop_was_counted_in_prometheus(self):
        """Half one of the pair. Without this the log assertion below proves nothing about the
        counter, and the two halves are only interesting together."""
        deadline = time.time() + 60
        after = self.before
        while time.time() < deadline:
            after = prom_scalar(
                f'sum(acs_ingestion_messages_dropped_total{{reason="{REASON}"}})')
            if after > self.before:
                return
            time.sleep(5)
        self.fail(
            f"the drop counter for reason={REASON} did not increase "
            f"({self.before} -> {after}) after publishing DDATA for an unregistered device. "
            f"Either the broker refused the publish (check the credential), or the daemon did "
            f"not take the drop arm."
        )

    def test_the_same_drop_is_readable_in_the_log_store_naming_the_device(self):
        """
        HALF TWO, AND THE CLAIM THE LOG STORE EXISTS FOR.

        Prometheus can say a drop happened and how many. It cannot say WHICH DEVICE, because its
        endpoint is served without a credential and carries no device data of any kind by design.
        This asserts the other half arrived: the same reason, spelled identically, on a line that
        names the device the counter could not.

        The query is the one the dashboard's drop panel links to, so a failure here is also a
        broken drill-down.
        """
        expr = f'{{service="ingestion"}} | json | reason = "{REASON}"'
        deadline = time.time() + PROPAGATION_TIMEOUT
        seen = []
        while time.time() < deadline:
            seen = [
                v[1] for s in loki_query(expr, limit=200) for v in s["values"]
                if self.device in v[1]
            ]
            if seen:
                break
            time.sleep(5)

        self.assertTrue(
            seen,
            f"no line in the log store carries reason={REASON} and device={self.device}. The "
            f"counter incremented, so the drop happened -- this is the half that was lost. "
            f"Check that alloy is collecting `ingestion` and that LOG_FORMAT=json.",
        )

        record = json.loads(seen[0])
        self.assertEqual(REASON, record["reason"])
        self.assertEqual(self.device, record["device"],
                         "the line names a different device than the one that was dropped")
        self.assertEqual("WARNING", record["level"])

    def test_the_prometheus_label_and_the_logged_field_are_the_same_string(self):
        """
        THE DRILL-DOWN CONTRACT, asserted against two live stores rather than against source.

        `ingestion/test_structured_logging.py` asserts this statically, from ingestion.py and
        metrics.py. That check cannot see a renderer, a relabel rule or a parser stage changing
        the string on its way to either store -- which is exactly what a collector config is for
        and therefore exactly what could break it.
        """
        labels = {
            r["metric"]["reason"]
            for r in prom_query("acs_ingestion_messages_dropped_total")
            if "reason" in r["metric"]
        }
        self.assertIn(REASON, labels,
                      f"Prometheus exports no reason={REASON}; exported: {sorted(labels)}")

        # POLLED, FOR THE REASON THE SIBLING ABOVE IS. This used to query once, and it runs
        # BEFORE the polling test alphabetically -- so on a stack where the drop had happened but
        # the line had not yet travelled daemon -> Docker -> Alloy -> Loki, this failed with "no
        # logged drop reasons", which reads as a broken drill-down contract rather than as a race.
        # Observed doing exactly that: the line was in the store, correct, seconds later.
        expr = f'{{service="ingestion"}} | json | reason != ""'
        deadline = time.time() + PROPAGATION_TIMEOUT
        fields = set()
        while time.time() < deadline:
            fields = {
                json.loads(v[1])["reason"]
                for s in loki_query(expr, limit=200) for v in s["values"]
            }
            if fields:
                break
            time.sleep(5)

        self.assertTrue(fields, "no logged drop reasons found in the store to compare against")
        self.assertTrue(
            fields <= labels,
            f"the store holds reasons Prometheus does not export: {sorted(fields - labels)}. "
            f"A panel filtered on one of those would link to logs that exist and never resolve.",
        )


class MultilineTestCase(unittest.TestCase):
    """The collector's `stage.multiline`, which nothing else exercises."""

    def test_a_python_traceback_arrives_as_one_entry(self):
        """
        The runtime emits one log entry PER LINE, so an eight-line traceback becomes eight
        unrelated records -- each one useless, and the one naming the exception separated from
        the one naming the code. The collector (the chart's obs/alloy.yaml) rejoins them on a line
        that starts with neither a timestamp nor a `{`.

        ASSERTED AGAINST WHATEVER TRACEBACKS THE STACK HAS, rather than by provoking one. Making
        a daemon throw on demand means either shipping a fault injection path or restarting a
        service mid-suite, and both are worse than a check that skips when the stack has been
        healthy -- which is itself the good outcome.
        """
        rows = loki_query('{service=~"ingestion|playback"} |= "Traceback (most recent call last)"',
                          since_seconds=86400, limit=20)
        lines = [v[1] for s in rows for v in s["values"]]
        if not lines:
            # NOT gated by REQUIRE_LOG_PIPELINE, unlike every other guard here. The others say
            # "the stack is missing"; this one says "the stack has been healthy", which is the
            # good outcome and is not something CI can arrange. The regex itself is asserted in
            # ingestion/test_structured_logging.py, which runs unconditionally.
            self.skipTest(
                "no traceback in the last 24h to check against -- the stack has been healthy, "
                "which is not a failure of this assertion"
            )
        # A REJOINED TRACEBACK IS NOT A MULTI-LINE STRING UNDER `LOG_FORMAT=json`, WHICH IS WHAT
        # BOTH DEPLOYMENTS NOW SET. JSONFormatter puts the traceback in the `exc` field, and
        # json.dumps escapes its newlines -- so the record is ONE physical line containing the
        # two-character sequence `\n`. Counting physical newlines asserted the text-mode shape and
        # would have failed on a healthy stack the moment anything logged `exc_info=True`.
        #
        # So the assertion is on what actually matters either way: the whole traceback is in ONE
        # entry, rather than split across several. `File "` appears once per frame, so a rejoined
        # traceback carries the header AND at least one frame in the same record.
        def whole(entry):
            try:
                payload = json.loads(entry).get("exc", "")
            except (ValueError, AttributeError):
                payload = entry
            return "Traceback (most recent call last)" in payload and 'File "' in payload

        self.assertTrue(
            any(whole(l) for l in lines),
            "no collected traceback carries both its header and a stack frame in ONE entry, so "
            "the exception is arriving split across records -- stage.multiline is not rejoining "
            "it. Note the stage is confined to ingestion|playback by a stage.match in "
            "alloy/config.alloy; if that selector no longer covers these services, this is what "
            "notices.",
        )


    def test_an_uncaught_traceback_is_rejoined_into_one_entry(self):
        """
        THE REJOINING, PROVOKED RATHER THAN WAITED FOR.

        The test above asserts against whatever tracebacks the stack happens to hold and skips
        when it has been healthy. That skip is the good outcome, and it is also why the stage was
        never actually proven: on a healthy stack nothing ever exercised it.

        HOW THIS AVOIDS BOTH COSTS THE ROADMAP REFUSED. The entry said closing this meant either a
        fault-injection path in the daemon or restarting a service mid-suite. It needs neither.
        Alloy discovers pods through the API server and derives `service` from the component
        LABEL, so a throwaway pod carrying the ingestion component label is
        collected by the same pipeline, matches the same `stage.match` selector and is subject to
        the same `stage.multiline`. Nothing in the daemon changes and no running service is
        touched.

        AND IT IS THE DAEMON'S OWN IMAGE, running the daemon's own `logging_config.get_logger`, so
        the first line comes out of `JSONFormatter` rather than being typed out here. A test that
        wrote that line by hand would be asserting the collector against a restatement of the
        format instead of the format.

        THE SHAPE IS A CRASH, WHICH IS NOT THE `exc_info=True` CASE. Under `LOG_FORMAT=json` --
        what both targets set -- a HANDLED exception is not multi-line at all: `JSONFormatter` puts
        it in the `exc` field and `json.dumps` escapes the newlines. The stage earns its place on
        the UNHANDLED case, where Python writes a raw traceback straight to stderr with no
        formatter in the path. That is a daemon dying, which is when the log is worth most, and it
        is the only shape that reaches the stage.

        WHAT THE FIRST LINE OF A RAW TRACEBACK DOES, asserted because it is the counter-intuitive
        half: `Traceback (most recent call last):` matches neither `{` nor an ISO timestamp, so it
        does not OPEN a block -- it is appended to the record above it. The crash therefore arrives
        glued to the last line the service logged before it died, under that line's timestamp.
        """
        image = os.getenv("PROBE_IMAGE") or stack_exec.default_probe_image()
        if not stack_exec.probe_image_available(image):
            skip_or_fail(self, "the image " + image + " is not built, so the probe cannot run the "
                               "daemon's own formatter: build the ingestion image first")

        token = "multiline-probe-" + secrets.token_hex(6)

        # A FIXED CONTAINER NAME, WITH THE UNIQUENESS IN THE LINE INSTEAD. `container` is a label,
        # so a per-run name would mint a new Loki stream on every run -- the unbounded cardinality
        # the collector config refuses for `device`, arriving through the back door of a test. One
        # name means one stream however often this runs; the token separates the runs inside it.
        name = "acs-cymru_multiline_probe"

        # THE SLEEP IS DISCOVERY, NOT PADDING. Pod discovery refreshes every 15s, so a
        # pod that starts and dies inside one interval is never seen and collects nothing.
        # The probe waits to BE FOUND, then logs, then crashes.
        inner = "\n".join([
            "import time",
            "from logging_config import get_logger",
            "log = get_logger('" + token + "')",
            "log.info('" + token + " about to crash')",
            "time.sleep(0.5)",
            "raise RuntimeError('" + token + " uncaught')",
        ])
        script = "sleep 25; python -c " + shlex.quote(inner) + "; sleep 10"

        # THE LABEL IS THE WHOLE TRICK. The probe carries the chart's component label for the
        # ingestion service, which discovery.relabel maps to `service`
        # and the stage.match selector reads. Narrow that selector and this container stops
        # matching -- which is a thing worth having noticed.
        started = stack_exec.run_probe(name, image, script, component="ingestion",
                                       env={"LOG_FORMAT": "json", "PYTHONUNBUFFERED": "1"})
        self.assertEqual(started.returncode, 0,
                         "could not start the probe container: " + started.stderr.strip())

        try:
            deadline = time.time() + 25 + PROPAGATION_TIMEOUT
            entries = []
            while time.time() < deadline:
                rows = loki_query('{service="ingestion"} |= "' + token + '"',
                                  since_seconds=600, limit=20)
                entries = [v[1] for s in rows for v in s["values"]]
                if any("Traceback (most recent call last)" in e for e in entries):
                    break
                time.sleep(3)

            self.assertTrue(
                entries,
                "nothing carrying " + token + " reached the store in time. The probe container "
                "ran, so this is collection rather than the daemon: check the collector's "
                "discovery (discovery.kubernetes, and the component label the probe carries).",
            )

            rejoined = [e for e in entries
                        if "Traceback (most recent call last)" in e and 'File "' in e]
            self.assertTrue(
                rejoined,
                "the traceback reached the store SPLIT ACROSS ENTRIES -- no single entry carries "
                "both its header and a stack frame. stage.multiline is not rejoining it, which "
                "turns every crash in the store into a heap of unrelated-looking records, the "
                "line naming the error separated from the line naming the code. Check the "
                "`firstline` regex in alloy/config.alloy against what logging_config.py emits, "
                "and that the stage.match selector still covers `ingestion`.\n"
                "entries seen: " + repr(entries),
            )

            self.assertTrue(
                any(e.lstrip().startswith("{") for e in rejoined),
                "the traceback was rejoined but not onto the JSON record that preceded it, so a "
                "crash is no longer attached to the last thing the service logged before dying.\n"
                "entries seen: " + repr(entries),
            )
        finally:
            stack_exec.remove_probe(name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
