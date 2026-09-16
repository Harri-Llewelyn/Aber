"""
What the ingestion daemon publishes, and why each series is allowed to exist.

WHAT THIS MODULE IS. The declaration: which flat counter name is published as which Prometheus
metric (`COUNTER_MAP`), what each metric means (`HELP`), which are gauges (`TYPES`), and the HTTP
endpoint that serves them. `registry.py` builds the metric objects from these tables and
`prometheus_client` owns the registry, the exposition format and the histogram arithmetic.

THE TRANSLATION IS THE POINT AND IT STAYS. `ingestion.py` counts under flat names at the site that
already made the decision -- `count("dropped_gateway_binding")`, one-to-one with the
`logger.warning` beside it -- so the counters and the log cannot disagree about what happened.
Re-instrumenting those sites with metric objects would put the two out of step at exactly the
moments that matter. What a scraper sees is
`acs_ingestion_messages_dropped_total{reason="gateway_binding"}`, and COUNTER_MAP is where that is
decided. Adding a metric is a line here, not a change on the hot path.

WHAT THIS ENDPOINT MUST NOT BECOME, and the line has moved once -- deliberately, and this records
where it now sits.

IT NEEDS NO CREDENTIAL, so anything here is exposed to whatever can reach the port. Every addition
is a decision, not a detail.

The endpoint is cluster-internal (the `ingestion-metrics` Service, scraped by Alloy) with no
Ingress route, which narrows WHO can reach it and changes nothing about what this file may put
behind it; the rules below were written for an unauthenticated endpoint and still are.

IT USED TO SERVE COUNTERS AND NOTHING ELSE. It now also serves SEVEN GAUGES DESCRIBING THE
APPLIANCES THEMSELVES -- uptime, load, available memory, free disk, and when each last reported,
plus each appliance's CLOCK OFFSET and when that was measured -- all labelled by `edge_node`. The
reason for the first five is that `gateways.disk_free_bytes` and its neighbours hold a LATEST VALUE
AND NO HISTORY (archived migration 0035 says so in its own header), so "is that appliance's disk
filling" is answerable here and nowhere else in the stack. A dashboard reading the database can
only ever draw a flat line at `now`.

THE CLOCK PAIR IS HERE FOR A DIFFERENT REASON AND IT IS WORTH SEPARATING. It corresponds to no
database column at all: ingestion.py derives it by subtracting the timestamp an appliance put on
its own heartbeat from the time this daemon received it, and stores it nowhere else. Drift is the
question -- an appliance that gains a second a day is a different fault from one that jumped an
hour at a reboot -- and only a time series can be asked it. What it exposes is that a named
appliance's clock disagrees with the platform's, which is neither an asset reading nor a secret,
and `edge_node` is already public on the broker.

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
# EVERY DROP PATH IS HERE, cross-checked against the `count("dropped_*")` sites in ingestion.py
# by test_metrics_endpoint.py, which reads the sites out of the source. A counter missing from this
# table is invisible to a scraper, which is the failure mode this file exists to avoid -- so an
# unmapped name lands under `acs_ingestion_unmapped_counter_total` rather than being discarded.
# ---------------------------------------------------------------------------------------------
COUNTER_MAP = {
    # Throughput.
    "metrics_written": ("acs_ingestion_metrics_written_total", {}),
    "written_messages": ("acs_ingestion_messages_written_total", {}),
    # Drops, one label value per reason. The flat names encode the reason already; this is where
    # that convention becomes a dimension a query can group by.
    "dropped_gateway_binding": (
        "acs_ingestion_messages_dropped_total", {"reason": "gateway_binding"}),
    "dropped_gateway_archived": (
        "acs_ingestion_messages_dropped_total", {"reason": "gateway_archived"}),
    # One reason for all three message kinds, unlike the directory-unavailable family below: an
    # archived device refuses a birth, a death and a reading for the same cause and at the same
    # cost, and the log line beside each says which kind it was.
    "dropped_device_archived": (
        "acs_ingestion_messages_dropped_total", {"reason": "device_archived"}),
    "dropped_quarantined_or_unregistered": (
        "acs_ingestion_messages_dropped_total", {"reason": "quarantined_or_unregistered"}),
    # The four directory-unavailable reasons are split by MESSAGE KIND because the harm differs
    # by an order of magnitude and one series could not express that (#126): a dropped DDATA is
    # one sample, a dropped DBIRTH is a device nothing can decode until it births again.
    # The unqualified `directory_unavailable` is the DDATA case and keeps its original name --
    # it is a shipped series that dashboards and the drop alert already read, and renaming it
    # for symmetry would break continuity to say nothing new.
    "dropped_directory_unavailable": (
        "acs_ingestion_messages_dropped_total", {"reason": "directory_unavailable"}),
    "dropped_dbirth_directory_unavailable": (
        "acs_ingestion_messages_dropped_total", {"reason": "dbirth_directory_unavailable"}),
    "dropped_ddeath_directory_unavailable": (
        "acs_ingestion_messages_dropped_total", {"reason": "ddeath_directory_unavailable"}),
    "dropped_node_message_directory_unavailable": (
        "acs_ingestion_messages_dropped_total", {"reason": "node_message_directory_unavailable"}),
    "dropped_db_unavailable": (
        "acs_ingestion_messages_dropped_total", {"reason": "db_unavailable"}),
    "dropped_write_queue_full": (
        "acs_ingestion_messages_dropped_total", {"reason": "write_queue_full"}),
    # Per-metric rejections, which are NOT message drops -- the message was accepted and some of
    # its metrics were not. Kept as separate series so a query cannot conflate them.
    # `metrics_rejected_timestamp` is absent DELIBERATELY: it leaves labelled by edge node, and
    # EXPORTED_LABELLED_INSTEAD below is where that is recorded.
    "metrics_unresolved_alias": ("acs_ingestion_alias_unresolved_total", {}),
    "metrics_rejected_schema": ("acs_ingestion_schema_rejected_total", {}),
    # The historian write path.
    "write_failures": ("acs_ingestion_write_failures_total", {}),
    "write_batch_failures": ("acs_ingestion_write_batch_failures_total", {}),
    "db_reconnects": ("acs_ingestion_db_reconnects_total", {}),
    "db_connect_failures": ("acs_ingestion_db_connect_failures_total", {}),
    "db_heals": ("acs_ingestion_db_heals_total", {}),
    "db_heal_failures": ("acs_ingestion_db_heal_failures_total", {}),
    # Gateway lifecycle.
    "gateway_heartbeats": ("acs_ingestion_gateway_heartbeats_total", {}),
    "gateway_status_transitions": ("acs_ingestion_gateway_status_transitions_total", {}),
    "gateway_status_reserved_rejected": (
        "acs_ingestion_gateway_status_reserved_rejected_total", {}),
    "device_state_writes": ("acs_ingestion_device_state_writes_total", {}),
    "device_state_writes_skipped": ("acs_ingestion_device_state_writes_skipped_total", {}),
    # Schema conformance (archived migration 0026).
    "payload_violations_recorded": ("acs_ingestion_payload_violations_recorded_total", {}),
    "payload_violations_suppressed": ("acs_ingestion_payload_violations_suppressed_total", {}),
    "payload_violation_write_failures": (
        "acs_ingestion_payload_violation_write_failures_total", {}),
    # Appliance health (archived migration 0035).
    "gateway_health_metrics_rejected": (
        "acs_ingestion_gateway_health_rejected_total", {}),
    # The UNS bridge (uns_publish.py): topics written, and readings not republished by reason.
    # The reasons are uns_publish.SKIP_REASONS; test_uns_publish.py holds the two lists together.
    "uns_published": ("acs_ingestion_uns_published_total", {}),
    "uns_skipped_site_unset": ("acs_ingestion_uns_skipped_total", {"reason": "site_unset"}),
    "uns_skipped_location_unknown": ("acs_ingestion_uns_skipped_total", {"reason": "location_unknown"}),
    "uns_skipped_lane": ("acs_ingestion_uns_skipped_total", {"reason": "lane"}),
    "uns_skipped_unassigned": ("acs_ingestion_uns_skipped_total", {"reason": "unassigned"}),
    "uns_skipped_cell_unfiled": ("acs_ingestion_uns_skipped_total", {"reason": "cell_unfiled"}),
    "uns_skipped_unsafe_name": ("acs_ingestion_uns_skipped_total", {"reason": "unsafe_name"}),
    "uns_skipped_publish_error": ("acs_ingestion_uns_skipped_total", {"reason": "publish_error"}),
}

# FLAT COUNTERS THAT ARE DELIBERATELY NOT EXPORTED UNDER A NAME OF THEIR OWN, each because the
# same event already leaves through a LABELLED series and a scraper summing both would count it
# twice. `flat name -> (the series it is summed back from, why)`.
#
# THIS IS A STATEMENT ABOUT THE EXPOSITION AND NOT ABOUT THE COUNTER. Every name here is still
# reported by the STATS log line, which is the property this module's header exists to protect:
# each counter reads back under the flat name the call site uses. `registry.counter_snapshot()`
# sums the named series to get it, which is exact because both call sites are adjacent and take
# the same increment -- `count("messages_total")` sits on the line above
# `count(f"messages_{msg_type}")`, and the rejected-timestamp pair likewise.
#
# Leaving a name unmapped instead would surface it under the
# `acs_ingestion_unmapped_counter_total` catch-all, which means the opposite of what is meant here.
EXPORTED_LABELLED_INSTEAD = {
    "messages_total": (
        "acs_ingestion_messages_total",
        "the sum of acs_ingestion_messages_total{msg_type=...}; sum() those instead"),
    "metrics_rejected_timestamp": (
        "acs_ingestion_timestamps_rejected_total",
        "exported as acs_ingestion_timestamps_rejected_total{edge_node=...}, so a rejected "
        "timestamp names the appliance whose clock caused it"),
}

HELP = {
    "acs_ingestion_messages_total":
        "Sparkplug messages the daemon acted on, after parsing and the command-topic filter.",
    "acs_ingestion_messages_written_total":
        "DDATA messages whose telemetry the historian committed. Divide acs_ingestion_write_seconds_count "
        "into it for the messages per transaction: 1 while the writer keeps up, rising as it batches.",
    "acs_ingestion_metrics_written_total":
        "Individual metric samples written to the historian.",
    "acs_ingestion_messages_dropped_total":
        "Messages refused, by reason. Any non-zero value is telemetry that was NOT recorded.",
    "acs_ingestion_timestamps_rejected_total":
        "Metrics whose timestamp fell outside the sanity window, BY EDGE NODE; the message itself "
        "was still processed. This telemetry was refused rather than clamped and cannot be "
        "recovered. Read it beside acs_ingestion_gateway_clock_offset_seconds for the same "
        "appliance: a rising count there is almost always a clock that has drifted past the "
        "window rather than anything about the device.",
    "acs_ingestion_alias_unresolved_total":
        "Metrics carrying an alias with no known name, pending a rebirth.",
    "acs_ingestion_schema_rejected_total":
        "Metrics DROPPED for contradicting their device's bound schema. Non-zero only for a device set to conformance_policy=enforce (0050); this telemetry was not written and cannot be recovered.",
    "acs_ingestion_write_batch_failures_total":
        "Transactions carrying more than one message that failed and were retried one message at a "
        "time. The message at fault is counted by acs_ingestion_write_failures_total; the others were "
        "written on the retry.",
    "acs_ingestion_write_queue_depth":
        "DDATA messages decided by the callback thread and not yet written. THE SATURATION SIGNAL: "
        "it grows only while the writer is behind the fleet, and a full queue drops with "
        "reason=\"write_queue_full\".",
    "acs_ingestion_write_failures_total":
        "Historian writes that raised. Telemetry from these is lost.",
    "acs_ingestion_uns_published_total":
        "Readings republished on the Unified Namespace (uns/...) after the historian commit. Zero "
        "while UNS_MQTT_ENABLED is unset.",
    "acs_ingestion_uns_skipped_total":
        "Readings the UNS bridge did not republish, by reason. Nothing here is lost: the historian "
        "holds every one. site_unset means the site.name setting is empty; unassigned and "
        "cell_unfiled are the two Unassigned queues on the dashboard; lane is a shadow or "
        "simulated device; unsafe_name is a segment carrying / + or #.",
    "acs_ingestion_uns_publish_seconds":
        "Time the UNS republish takes per DDATA, on the historian writer thread after the commit. "
        "Read it beside acs_ingestion_write_seconds: both occupy the one thread whose saturation "
        "is the daemon's ceiling.",
    "acs_ingestion_db_reconnects_total": "Times the historian connection was re-opened.",
    "acs_ingestion_db_connect_failures_total": "Failed attempts to open the historian connection.",
    "acs_ingestion_db_heals_total":
        "Times the background recovery loop opened the historian connection the daemon should "
        "already have been holding. NON-ZERO MEANS A STARTUP ORDERING RACE WAS LOST: the daemon "
        "reached its MQTT loop with no database, which `depends_on` cannot prevent on a Docker "
        "daemon restart. Nothing was dropped -- this counts a repair, not a loss.",
    "acs_ingestion_db_heal_failures_total":
        "Failed attempts by the background recovery loop. DISTINCT FROM "
        "acs_ingestion_db_connect_failures_total, which counts a connection a MESSAGE needed and "
        "therefore telemetry dropped. This one drops nothing: it is a daemon with no traffic "
        "waiting for a historian, and only says how long it has been waiting.",
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
        "Wall time of one historian transaction, from acquiring the connection to after the commit. "
        "One observation per transaction, which carries every message queued while the previous one "
        "ran. rate(_sum) is the fraction of the writer thread in use, and that is the capacity gauge: "
        "at 1 the writer is saturated and acs_ingestion_write_queue_depth grows. Committed writes only "
        "-- a transaction that raised is counted by acs_ingestion_write_failures_total and excluded, so "
        "a p99 spike unambiguously means a slow database and never an absent one. Observations at or "
        "above 0.25s are the bounded reconnect running, not the INSERT.",
    "acs_ingestion_up": "1 while the daemon is serving this endpoint.",
    "acs_ingestion_db_connected":
        "1 when the historian connection is open. 0 means telemetry is being dropped now.",
    "acs_ingestion_mqtt_connected":
        "1 when the daemon is subscribed to spBv1.0/#. THE SUBSCRIPTION, NOT THE CONNECTION: a "
        "connected client that has not subscribed receives nothing, and that is the state worth "
        "telling apart. `acs_ingestion_up` is 1 as soon as this endpoint is served, which happens "
        "first -- so a stack that is up with this at 0 is running and deaf.",
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
    "acs_ingestion_gateway_clock_offset_seconds":
        "How far each appliance's own clock is from this server's, in seconds, from the timestamp "
        "on its heartbeat against the time that heartbeat arrived. POSITIVE MEANS THE APPLIANCE IS "
        "AHEAD, which is the direction that corrupts: devices supply their own metric timestamps "
        "and are trusted for ordering, so a gateway a minute fast files every reading a minute "
        "early, silently and permanently. Nothing corrects this centrally -- it is fixed on the "
        "appliance. Beyond the sanity window the telemetry is dropped instead and counted by "
        "acs_ingestion_timestamps_rejected_total. NDEATH is excluded from the measurement: it is "
        "the broker's Last Will and carries the clock reading of connect time.",
    "acs_ingestion_gateway_clock_measured_timestamp_seconds":
        "When each appliance's clock offset was last measured, as unix seconds. READ THE OFFSET "
        "BESIDE THIS ONE: a gauge holds its last value indefinitely, so an appliance powered down "
        "for a month still reports whatever its clock said on the day it left.",
}

TYPES = {
    "acs_ingestion_up": "gauge",
    "acs_ingestion_db_connected": "gauge",
    "acs_ingestion_mqtt_connected": "gauge",
    "acs_ingestion_write_queue_depth": "gauge",
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
    # The clock pair. A gauge and not a counter: an offset goes both ways and can shrink, which is
    # exactly what a clock being corrected looks like.
    "acs_ingestion_gateway_clock_offset_seconds": "gauge",
    "acs_ingestion_gateway_clock_measured_timestamp_seconds": "gauge",
}


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

    NOT `prometheus_client.start_http_server`, though the body it serves is prometheus_client's.
    That helper answers every path with the metrics, so a typo in a scrape config would look like a
    working target; and it raises on a port it cannot bind, which here has to be survivable. Both
    behaviours below are this daemon's policy rather than the format, which is the line this module
    keeps: upstream renders, we decide what is served and what happens when it cannot be.

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
