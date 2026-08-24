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

WHAT THIS ENDPOINT MUST NOT BECOME, and the line has moved once -- deliberately, and this records
where it now sits.

IT NEEDS NO CREDENTIAL AND IS PUBLISHED TO THE HOST (`9108:9108`), so anything here is exposed to
whatever can reach that port. Every addition is a decision, not a detail.

IT USED TO SERVE COUNTERS AND NOTHING ELSE. It now also serves FIVE GAUGES DESCRIBING THE
APPLIANCES THEMSELVES -- uptime, load, available memory, free disk, and when each last reported --
labelled by `edge_node`. The reason is that `gateways.disk_free_bytes` and its neighbours hold a
LATEST VALUE AND NO HISTORY (migration 0035 says so in its own header), so "is that appliance's
disk filling" is answerable here and nowhere else in the stack. A dashboard reading the database
can only ever draw a flat line at `now`.

WHAT IS DELIBERATELY NOT HERE, because the exposure is unauthenticated:

  * NO DEVICE DATA OF ANY KIND -- no asset telemetry, no device names, no payloads. That half of
    the original rule is unchanged and is the half that matters most.
  * `agent_version` and `flow_hash` stay in the database. A flow hash is a fingerprint of an
    appliance's deployed configuration and a version string says which vulnerabilities it has;
    neither needs a trend line, so neither pays for the exposure.
  * `cert_expires_at` stays in the database too, and its alert rule reads it there. It is a fixed
    date that changes only at re-enrolment, so it gains nothing from a time series -- and it is
    the most useful single fact an attacker on this port could learn, being the day the whole
    fleet's trust anchor dies.

The one label carrying asset identity remains `edge_node`, a gateway's Sparkplug node id, which is
already public on the broker.
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
    "dropped_gateway_archived": (
        "acs_ingestion_messages_dropped_total", {"reason": "gateway_archived"}),
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
    # Appliance health (migration 0035).
    "gateway_health_metrics_rejected": (
        "acs_ingestion_gateway_health_rejected_total", {}),
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
    "acs_ingestion_cache_entries":
        "Entries currently held in each entity resolution cache. Bounded by MAX_ENTITIES_PER_CACHE.",
    "acs_ingestion_cache_evictions_total":
        "Entries dropped from a cache because it was at its capacity bound. NON-ZERO IS THE "
        "INTERESTING CASE: either the fleet is larger than the cap, or something is publishing "
        "ids that churn -- a misconfigured gateway, a fault loop, or enumeration. Read it beside "
        "acs_ingestion_messages_dropped_total{reason=\"gateway_binding\"}, which is what an "
        "enumeration attempt would also move.",
    "acs_ingestion_write_seconds":
        "Wall time one DDATA message spends occupying the historian write path, from acquiring "
        "the connection to after the commit. THE SINGLE-WRITER CEILING IS THIS SERIES: every "
        "write happens on the one paho callback thread, so a slow write stalls every other "
        "device rather than only its own. Committed writes only -- a write that raised is "
        "counted by acs_ingestion_write_failures_total and excluded here, so that a p99 spike "
        "unambiguously means a slow database and never an absent one. Observations at or above "
        "0.25s are the bounded reconnect running, not the INSERT.",
    "acs_ingestion_up": "1 while the daemon is serving this endpoint.",
    "acs_ingestion_db_connected":
        "1 when the historian connection is open. 0 means telemetry is being dropped now.",
    "acs_ingestion_unmapped_counter_total":
        "An internal counter with no Prometheus mapping. Non-zero means metrics.py's COUNTER_MAP "
        "has fallen behind ingestion.py -- the counter is still being kept, just not named here.",
    "acs_ingestion_gateway_health_rejected_total":
        "Appliance health metrics dropped as unusable -- negative, non-finite, over-length, or "
        "carrying the wrong value type. The heartbeat that carried them still landed; migration "
        "0035 records why that trade is made in the daemon rather than at a CHECK constraint.",
    "acs_ingestion_gateway_uptime_seconds":
        "Seconds since an appliance's Node-RED runtime started, as last reported by it. Process "
        "uptime, not host uptime: a restarted container resets it while the machine stays up.",
    "acs_ingestion_gateway_load1":
        "An appliance's host 1-minute load average, as last reported by it. NOT normalised by core "
        "count -- compare a gateway against itself over time, never against another.",
    "acs_ingestion_gateway_mem_available_bytes":
        "An appliance's host MemAvailable. Available, not free: it counts reclaimable cache, which "
        "is the number that predicts whether an allocation will succeed.",
    "acs_ingestion_gateway_disk_free_bytes":
        "Free bytes on an appliance's root filesystem. THE SERIES THIS ENDPOINT GAINED A GAUGE "
        "FOR: gateways.disk_free_bytes holds the latest value and no history, so 'is the disk "
        "filling' is answerable here and nowhere else.",
    "acs_ingestion_gateway_health_reported_timestamp_seconds":
        "When each appliance last reported any health metric, as unix seconds. Read the four "
        "gauges above BESIDE this one: they hold their last value indefinitely, so a stale "
        "timestamp is the only thing that distinguishes a steady disk figure from a dead "
        "collector.",
}

TYPES = {
    "acs_ingestion_up": "gauge",
    "acs_ingestion_db_connected": "gauge",
    # A LABELLED GAUGE, which is why it arrives through `labelled` rather than through `gauges`.
    # The TYPE is decided here by name, not by which argument a series came in on -- so a gauge
    # that needs a label dimension has somewhere to go without a fourth parameter.
    "acs_ingestion_cache_entries": "gauge",
    # The appliance health gauges, labelled by edge node. Same mechanism as the cache gauge above:
    # read at scrape time from the daemon's last-seen state, because they are states rather than
    # events. See the header for what is deliberately NOT among them.
    "acs_ingestion_gateway_uptime_seconds": "gauge",
    "acs_ingestion_gateway_load1": "gauge",
    "acs_ingestion_gateway_mem_available_bytes": "gauge",
    "acs_ingestion_gateway_disk_free_bytes": "gauge",
    "acs_ingestion_gateway_health_reported_timestamp_seconds": "gauge",
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


def _format_le(value) -> str:
    """
    A bucket boundary as Prometheus expects to read it back.

    `repr` is what makes this correct rather than `str(round(...))`: the boundary in the `le`
    label is compared textually by anything joining series across scrapes, so 0.0025 must render
    as "0.0025" and never as "0.003" or "2.5e-03".
    """
    if value == float("inf"):
        return "+Inf"
    return repr(float(value))


def _render_histogram(out, metric, state):
    """
    One histogram family: cumulative `_bucket` series, then `_sum` and `_count`.

    BUCKETS ARE EMITTED IN EXPLICIT NUMERIC ORDER AND NEVER THROUGH THE SHARED SORT. The generic
    path below orders a metric's samples by their label items, which is a LEXICAL comparison --
    and lexically "10.0" < "2.5" and "+Inf" sorts before every digit. Routing buckets through it
    would emit a monotonically increasing sequence in the wrong order, which histogram_quantile()
    reads as a malformed histogram and answers with silently wrong quantiles. This function exists
    for that one reason.

    THE COUNTS ARRIVE PER BUCKET AND LEAVE CUMULATIVE. Prometheus defines `le` as "observations
    less than or equal to", so each bucket must include every bucket below it; ingestion.py stores
    the un-accumulated counts because that is one increment per observation on the callback thread
    instead of thirteen.
    """
    help_text = HELP.get(metric)
    if help_text:
        out.append(f"# HELP {metric} {help_text}")
    out.append(f"# TYPE {metric} histogram")

    running = 0
    for upper, n in state["buckets"]:
        running += n
        out.append(_line(f"{metric}_bucket", {"le": _format_le(upper)}, running))

    # +Inf IS THE TOTAL, NOT THE LAST FINITE BUCKET REPEATED. An observation above the top
    # boundary increments no bucket in ingestion.py, so taking it from `count` is what keeps it
    # present -- and Prometheus requires _bucket{le="+Inf"} to equal _count exactly.
    out.append(_line(f"{metric}_bucket", {"le": "+Inf"}, state["count"]))
    out.append(_line(f"{metric}_sum", {}, state["sum"]))
    out.append(_line(f"{metric}_count", {}, state["count"]))


def render_exposition(counters, labelled=None, gauges=None, histograms=None):
    """
    The text exposition format, built from a counter snapshot.

    @param counters  flat name -> int, from ingestion.counter_snapshot()
    @param labelled  (metric, ((k, v), ...)) -> int, for series the flat registry cannot express.
                     NOT COUNTERS ONLY: a series' TYPE comes from `TYPES` by metric name, so a
                     labelled GAUGE belongs here too -- `gauges` below takes no label dimension.
    @param gauges    metric -> value
    @param histograms  metric -> {"buckets": ((upper, count), ...), "sum": float, "count": int},
                     from ingestion.histogram_snapshot(). Rendered by _render_histogram, which
                     does NOT share the sorting path -- see the note there.

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

    for metric in sorted(histograms or {}):
        _render_histogram(out, metric, histograms[metric])

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
