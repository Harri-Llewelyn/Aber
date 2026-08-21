"""
Prometheus exposition for the ingestion daemon's existing counters.

WHY THIS IS A RENDERER AND NOT AN INSTRUMENTATION LIBRARY.

`ingestion.py` already keeps a monotonic registry -- `count()` into a dict behind a lock -- and
every increment sits at the site that already made the decision, one-to-one with an existing
`logger.warning`. That is the property worth protecting: the counters and the log cannot disagree
about what happened. Re-instrumenting those nineteen sites with a metrics library would put the
two out of step at exactly the moments that matter.

So this module TRANSLATES rather than replaces. It takes a snapshot of the flat registry and maps
it onto Prometheus names and labels. `count("dropped_gateway_binding")` stays exactly where it is;
what a scraper sees is `acs_ingestion_messages_dropped_total{reason="gateway_binding"}`.

NO NEW DEPENDENCY, and that is deliberate rather than stubborn. `requirements.txt` is four lines
and each is annotated; `prometheus_client` would bring a registry the daemon does not use, process
collectors it does not want, and a second place for a counter to live. The exposition format is a
documented text protocol -- name, labels, value, newline -- and rendering it is the smaller and
more auditable half of what the library would do.

WHAT THIS ENDPOINT MUST NOT BECOME. It serves counters and nothing else: no metric values, no
device names, no payloads. The one label carrying asset identity is `edge_node` on the sequence
counters, which is a gateway's Sparkplug node id and is already public on the broker. It needs no
credential, so anything it exposes is exposed to whatever can reach the port.
"""
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

# ---------------------------------------------------------------------------------------------
# The translation table: flat registry name -> (prometheus metric, labels)
#
# EVERY DROP PATH IS HERE, cross-checked against the `count("dropped_*")` sites in ingestion.py.
# A counter missing from this table is invisible to a scraper, which is the failure mode this
# file exists to avoid -- so `render_exposition` reports unmapped names under a catch-all rather
# than discarding them silently.
# ---------------------------------------------------------------------------------------------
COUNTER_MAP = {
    # Throughput.
    "metrics_written": ("acs_ingestion_metrics_written_total", {}),
    # Drops, one label value per reason. The flat names encode the reason already; this is where
    # that convention becomes a dimension a query can group by.
    "dropped_gateway_binding": (
        "acs_ingestion_messages_dropped_total", {"reason": "gateway_binding"}),
    "dropped_quarantined_or_unregistered": (
        "acs_ingestion_messages_dropped_total", {"reason": "quarantined_or_unregistered"}),
    "dropped_directory_unavailable": (
        "acs_ingestion_messages_dropped_total", {"reason": "directory_unavailable"}),
    "dropped_db_unavailable": (
        "acs_ingestion_messages_dropped_total", {"reason": "db_unavailable"}),
    # Per-metric rejections, which are NOT message drops -- the message was accepted and some of
    # its metrics were not. Kept as separate series so a query cannot conflate them.
    "metrics_rejected_timestamp": ("acs_ingestion_timestamps_rejected_total", {}),
    "metrics_unresolved_alias": ("acs_ingestion_alias_unresolved_total", {}),
    # The historian write path.
    "write_failures": ("acs_ingestion_write_failures_total", {}),
    "db_reconnects": ("acs_ingestion_db_reconnects_total", {}),
    "db_connect_failures": ("acs_ingestion_db_connect_failures_total", {}),
    # Gateway lifecycle.
    "gateway_heartbeats": ("acs_ingestion_gateway_heartbeats_total", {}),
    "gateway_status_transitions": ("acs_ingestion_gateway_status_transitions_total", {}),
    "gateway_status_reserved_rejected": (
        "acs_ingestion_gateway_status_reserved_rejected_total", {}),
    "device_state_writes": ("acs_ingestion_device_state_writes_total", {}),
    "device_state_writes_skipped": ("acs_ingestion_device_state_writes_skipped_total", {}),
    # Schema conformance (migration 0026).
    "payload_violations_recorded": ("acs_ingestion_payload_violations_recorded_total", {}),
    "payload_violations_suppressed": ("acs_ingestion_payload_violations_suppressed_total", {}),
    "payload_violation_write_failures": (
        "acs_ingestion_payload_violation_write_failures_total", {}),
}

HELP = {
    "acs_ingestion_messages_total":
        "Sparkplug messages the daemon acted on, after parsing and the command-topic filter.",
    "acs_ingestion_metrics_written_total":
        "Individual metric samples written to the historian.",
    "acs_ingestion_messages_dropped_total":
        "Messages refused, by reason. Any non-zero value is telemetry that was NOT recorded.",
    "acs_ingestion_timestamps_rejected_total":
        "Metrics whose timestamp failed validation; the message itself was still processed.",
    "acs_ingestion_alias_unresolved_total":
        "Metrics carrying an alias with no known name, pending a rebirth.",
    "acs_ingestion_write_failures_total":
        "Historian writes that raised. Telemetry from these is lost.",
    "acs_ingestion_db_reconnects_total": "Times the historian connection was re-opened.",
    "acs_ingestion_db_connect_failures_total": "Failed attempts to open the historian connection.",
    "acs_ingestion_gateway_heartbeats_total": "Gateway heartbeat stamps written.",
    "acs_ingestion_gateway_status_transitions_total": "Gateway status changes recorded.",
    "acs_ingestion_gateway_status_reserved_rejected_total":
        "Status writes refused because the value is reserved for the enrolment lifecycle.",
    "acs_ingestion_device_state_writes_total": "Device state rows written.",
    "acs_ingestion_device_state_writes_skipped_total":
        "Device state writes suppressed because nothing had changed.",
    "acs_ingestion_payload_violations_recorded_total":
        "DDATA payloads recorded in digital_thread as failing schema validation.",
    "acs_ingestion_payload_violations_suppressed_total":
        "Repeat violations not re-recorded, because the signature was unchanged.",
    "acs_ingestion_payload_violation_write_failures_total":
        "Violations that could not be recorded.",
    "acs_ingestion_sequence_gaps_total":
        "Sparkplug seq discontinuities, by edge node. Under report-by-exception this is the ONLY "
        "evidence that a message was lost between the edge node and the historian.",
    "acs_ingestion_sequence_messages_missed_total":
        "Messages implied lost by those gaps. One gap of 200 and 200 gaps of 1 are different "
        "faults and this is what separates them. A LOWER BOUND: seq is 8-bit, so a single gap "
        "larger than 255 wraps and is undercounted. Read it with the gap counter, never alone.",
    "acs_ingestion_up": "1 while the daemon is serving this endpoint.",
    "acs_ingestion_db_connected":
        "1 when the historian connection is open. 0 means telemetry is being dropped now.",
    "acs_ingestion_unmapped_counter_total":
        "An internal counter with no Prometheus mapping. Non-zero means metrics.py's COUNTER_MAP "
        "has fallen behind ingestion.py -- the counter is still being kept, just not named here.",
}

TYPES = {
    "acs_ingestion_up": "gauge",
    "acs_ingestion_db_connected": "gauge",
}


def _escape(value: str) -> str:
    """Label values are quoted, so a backslash, quote or newline in one would break the line."""
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
    )


def _line(name, labels, value):
    if labels:
        rendered = ",".join(f'{k}="{_escape(v)}"' for k, v in sorted(labels.items()))
        return f"{name}{{{rendered}}} {value}"
    return f"{name} {value}"


def render_exposition(counters, labelled=None, gauges=None):
    """
    The text exposition format, built from a counter snapshot.

    @param counters  flat name -> int, from ingestion.counter_snapshot()
    @param labelled  (metric, ((k, v), ...)) -> int, for series the flat registry cannot express
    @param gauges    metric -> value

    SERIES ARE GROUPED UNDER ONE HELP/TYPE PAIR. Prometheus requires that a metric name's HELP and
    TYPE appear once, before its samples; repeating them for each label combination is a parse
    error in strict scrapers and silently drops series in lenient ones.
    """
    series = {}

    def add(metric, labels, value):
        series.setdefault(metric, []).append((labels, value))

    for flat, total in (counters or {}).items():
        # `messages_<type>` is written per message type by ingestion.py already, so the msg_type
        # dimension costs nothing at the call site -- it is derived from a convention that was
        # there first.
        if flat.startswith("messages_") and flat != "messages_total":
            add("acs_ingestion_messages_total", {"msg_type": flat[len("messages_"):]}, total)
            continue
        if flat == "messages_total":
            # Deliberately NOT exported: it is the sum of the labelled series above, and a scraper
            # summing them would double-count. `sum(acs_ingestion_messages_total)` is the total.
            continue
        mapped = COUNTER_MAP.get(flat)
        if mapped:
            metric, labels = mapped
            add(metric, dict(labels), total)
        else:
            # NAMED, NOT DISCARDED. A counter added to ingestion.py without a mapping here would
            # otherwise vanish from monitoring with nothing to indicate it ever existed.
            add("acs_ingestion_unmapped_counter_total", {"counter": flat}, total)

    for (metric, label_items), total in (labelled or {}).items():
        add(metric, dict(label_items), total)

    for metric, value in (gauges or {}).items():
        add(metric, {}, value)

    out = []
    for metric in sorted(series):
        help_text = HELP.get(metric)
        if help_text:
            out.append(f"# HELP {metric} {help_text}")
        out.append(f"# TYPE {metric} {TYPES.get(metric, 'counter')}")
        for labels, value in sorted(series[metric], key=lambda s: sorted(s[0].items())):
            out.append(_line(metric, labels, value))
    return "\n".join(out) + "\n"


class _Handler(BaseHTTPRequestHandler):
    """`collect` is attached by start_metrics_server; it returns the rendered body."""

    collect = None

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's interface
        # ONLY /metrics. A handler that answered everything would make a typo in a scrape config
        # look like a working target serving an empty result.
        if self.path.split("?")[0] not in ("/metrics", "/"):
            self.send_error(404)
            return
        try:
            body = type(self).collect().encode("utf-8")
        except Exception:  # noqa: BLE001 - an exporter must never take the daemon down
            self.send_error(500)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        """Silent. Prometheus scrapes every 15s and each line would otherwise reach the log."""


def start_metrics_server(port, collect, logger=None):
    """
    Serve `collect()` on `port` from a daemon thread.

    A THREAD IN THE EXISTING PROCESS, matching the watchdog, heartbeat and stats reporter that are
    already there. A separate exporter process would need its own copy of the counters, which is
    the thing there must only be one of.

    FAILURE HERE MUST NOT STOP INGESTION. A port already in use is a monitoring problem; refusing
    to start the daemon over it would turn a missing graph into an outage.

    PORT 0 MEANS EPHEMERAL, as it does everywhere else in the socket API -- it is not a way to
    disable this. Whether the endpoint runs at all is a configuration decision and lives with the
    configuration, in ingestion.start_metrics_endpoint(). Overloading 0 here would have made the
    mechanism untestable: a test cannot ask for a free port without it.
    """
    handler = type("_BoundHandler", (_Handler,), {"collect": staticmethod(collect)})
    try:
        server = HTTPServer(("0.0.0.0", int(port)), handler)
    except OSError as exc:
        if logger:
            logger.warning(
                "Could not bind the metrics endpoint on port %s (%s). Ingestion continues; "
                "this component will have no metrics until it is restarted.", port, exc
            )
        return None

    threading.Thread(target=server.serve_forever, name="metrics-endpoint", daemon=True).start()
    if logger:
        logger.info("Metrics endpoint listening on :%s/metrics", port)
    return server
