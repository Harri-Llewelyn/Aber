"""
Recording the broker on behalf of the dashboard.

THERE IS NO SECOND SUBSCRIBER, AND THERE MUST NOT BE. This runs as one thread inside the ingestion
daemon, which already holds `spBv1.0/#` and the credential, so a capture opens no broker connection
of its own: `observe()` appends to a buffer when a job is active and the topic matches. A separate
consumer of the same topics would split the `seq` stream -- `_last_seq` in ingestion.py is keyed
`(group, edge_node)` -- and make the daemon's own gap detection fire permanently.

`observe()` runs on paho's network thread, on the hot path for every message the whole fleet
publishes, so it does the least it can: a tuple comparison, an append, and two counters, under a
lock held for the length of an append.

THE STOP FLAG IS A COLUMN, not an endpoint: this daemon serves exactly one HTTP endpoint,
Prometheus `/metrics`, and a flag survives a page reload. While idle the thread asks
`ingest_claim_capture_job()` for work every few seconds; while recording it reports progress once a
second and is told, in the same round trip, whether to stop.

Related: supabase/migrations/archive/0055_capture_orchestration.sql (the tables and every gate
         called here), capture.py (the file format, and the encoding preservation this reuses),
         README.md -> "Recording from the dashboard" (why the daemon hosts this, the two tables,
         and the three caps a job auto-terminates on).
"""

import json
import os
import threading
import time
from datetime import datetime, timezone

import capture
from logging_config import get_logger

# `get_logger`, NOT `logging.getLogger(__name__)`. This daemon configures NAMED loggers with
# `propagate = False`, so a module logger made the standard-library way has no handler and its INFO
# and DEBUG lines are discarded. Under the "ingestion" name rather than one of its own, so a capture
# line appears in the same stream, with the same format, as the ingestion it happens alongside.
# (docs/incidents.md -- "A worker that logged nothing looked like one nobody had asked for")
logger = get_logger("ingestion")

BUCKET = os.getenv("CAPTURE_BUCKET", "broker-captures")

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
SUPABASE_INGESTION_KEY = os.getenv("SUPABASE_INGESTION_KEY", "")
# The publishable key, presented as `apikey`; the gateway translates it (docs/gateway.md).
SUPABASE_GATEWAY_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")

# How often an idle worker looks for a queued job. Three seconds is the delay an operator sees
# between pressing Capture and the card appearing; polling faster buys nothing, because the rebirth
# request that opens a recording takes longer than that to come back.
POLL_INTERVAL_SECONDS = float(os.getenv("CAPTURE_POLL_INTERVAL_SECONDS", "3"))

# How often a running job writes its progress. This is what Realtime pushes to the running card,
# so it is also the card's refresh rate.
PROGRESS_INTERVAL_SECONDS = float(os.getenv("CAPTURE_PROGRESS_INTERVAL_SECONDS", "1"))

# How long to wait for the birth certificate before saying so. See `_JobState.birth_overdue`.
REBIRTH_GRACE_SECONDS = float(os.getenv("CAPTURE_REBIRTH_GRACE_SECONDS", "10"))

# Node-level message types, which carry no device segment. A DEVICE capture records these too --
# see the matching rule in `_JobState.matches()`.
_NODE_TYPES = ("NBIRTH", "NDATA", "NDEATH")
_BIRTH_TYPES = ("NBIRTH", "DBIRTH")


class _JobState:
    """The capture in flight. One at a time, enforced by a partial unique index in the database."""

    def __init__(self, job):
        self.job = job
        self.id = job["id"]
        self.group = job["sparkplug_group"]
        self.edge_node = job["edge_node_id"]
        self.device = job.get("device_sparkplug_id")
        self.storage_path = job["storage_path"]
        self.max_seconds = int(job.get("max_seconds") or 7200)
        self.max_messages = int(job.get("max_messages") or 100000)
        self.max_bytes = int(job.get("max_bytes") or 52428800)

        self.messages = []
        self.bytes = 0
        # Set by observe() on the paho thread when a cap is met, read by the worker thread on its
        # next tick. The recording stops at a message boundary rather than mid-append.
        self.cap_reason = None
        self.first_ms = None
        self.birth_captured = False
        self.rebirth_requested = False
        self.started_monotonic = time.monotonic()
        self.lock = threading.Lock()

    # ------------------------------------------------------------------------------------------
    def matches(self, parts):
        """
        Does this Sparkplug topic belong to the subject being recorded?

        A DEVICE CAPTURE TAKES THE NODE-LEVEL MESSAGES TOO, and that is the single most important
        line in this file. A device-scoped recording that kept only its own DDATA would omit the
        NBIRTH where the alias table lives -- and an alias-optimised gateway then yields a capture
        that replays as `unresolved_alias` and drops every metric, from a file that looks complete.
        ingestion.py documents that failure at `_alias_map`: it "ingests nothing at all from an
        alias-optimised gateway, and reports no error while doing it".
        """
        if len(parts) < 4 or parts[1] != self.group or parts[3] != self.edge_node:
            return False
        if self.device is None:
            return True
        if len(parts) < 5:
            # A node-level message on the subject's own edge node: the birth certificate and the
            # gateway heartbeats that frame it.
            return parts[2] in _NODE_TYPES
        return parts[4] == self.device

    # ------------------------------------------------------------------------------------------
    def append(self, topic, raw, msg_type):
        """Buffer one message. Returns the reason to stop, or None to keep going."""
        try:
            payload, encoding = capture.decode_wire_payload(raw)
        except Exception:
            # A payload this daemon cannot decode is not written down as if it had been. Recording
            # a placeholder would produce a capture that replays something the fleet never sent,
            # which is worse than a capture that is honestly short. Same rule as capture.py record.
            return None

        now_ms = int(time.time() * 1000)
        with self.lock:
            if self.first_ms is None:
                self.first_ms = now_ms
            entry = {
                "offset_ms": now_ms - self.first_ms,
                "topic": topic,
                "encoding": encoding,
                "payload": capture.payload_to_dict(payload),
            }
            self.messages.append(entry)
            # MEASURED, NOT ESTIMATED FROM THE WIRE. A protobuf payload expands several-fold as
            # JSON, so counting `len(raw)` would let a capture sail past its size cap and produce a
            # file the bucket refuses -- after the recording has succeeded and while it exists only
            # in this buffer. The file is written with indent=2 and is larger again, which is what
            # the bucket's 100 MiB against this 50 MiB cap is headroom for.
            self.bytes += len(json.dumps(entry))
            if msg_type in _BIRTH_TYPES:
                self.birth_captured = True

            if len(self.messages) >= self.max_messages:
                return "message cap reached (%d)" % self.max_messages
            if self.bytes >= self.max_bytes:
                return "size cap reached (%d bytes)" % self.max_bytes
        return None

    # ------------------------------------------------------------------------------------------
    @property
    def elapsed(self):
        return time.monotonic() - self.started_monotonic

    @property
    def birth_overdue(self):
        """
        No birth certificate, and long enough that somebody should be told.

        THE ANSWER OUTLIVES THE CARD, WHICH IS THE POINT. A banner shown during the recording exists
        only for the ten seconds nobody is watching; `birth_captured` on the finished record is
        where a file that cannot replay properly stops looking identical to one that can.
        """
        return not self.birth_captured and self.elapsed > REBIRTH_GRACE_SECONDS

    def snapshot(self):
        with self.lock:
            return len(self.messages), self.bytes, self.birth_captured

    def drain(self):
        with self.lock:
            msgs, self.messages = self.messages, []
            return msgs


# The active job, or None. Read on the paho thread by observe() and written by the worker thread;
# a bare attribute assignment is atomic in CPython, which is all the coordination this needs -- the
# buffer itself is guarded by the job's own lock.
_active = None
_supabase = None
_storage = None
_rebirth = None


def _storage_client():
    """
    A storage client that authenticates AS THE DAEMON, which the shared one does not.

    THE DAEMON'S `supabase_client` UPLOADS AS `anon`, AND NOTHING SAYS SO. ingestion.py builds it
    with the gateway key and then calls `supabase_client.postgrest.auth(SUPABASE_INGESTION_KEY)` --
    which authenticates the PostgREST sub-client and ONLY that one. `client.storage` is built
    separately and keeps the key it was constructed with:

        >>> dict(create_client(url, anon).storage._client.headers)
        {... 'apikey': 'anon', 'authorization': 'Bearer anon'}

    So the first version of this worker recorded perfectly and then failed every upload with
    `new row violates row-level security policy` -- a refusal that names RLS and is really about
    which identity the request carried. The bucket admits the ingestion principal; it does not
    admit `anon`, and nor should it.

    BUILT EXPLICITLY RATHER THAN BY MUTATING `supabase_client.storage._client.headers`, because
    ingestion.py already records what happens when this library's auth is set the obvious way:
    "supabase-py re-derives Authorization from the client's own token on every request, so the anon
    key goes out regardless ... That failure is quiet in the worst way". `storage3.create_client`
    takes the headers as an argument, so there is nothing left to re-derive.

    The apikey stays the ANON key, matching the pattern beside it: that header is for the gateway's
    filter, and the bearer token is what resolves the identity.
    """
    from storage3 import create_client as create_storage_client

    return create_storage_client(
        # TRAILING SLASH: storage3 warns and corrects it otherwise, and a UserWarning on every boot
        # is noise that trains a reader to skip the startup lines.
        SUPABASE_URL.rstrip("/") + "/storage/v1/",
        {
            "apikey": SUPABASE_GATEWAY_KEY,
            "Authorization": "Bearer " + (SUPABASE_INGESTION_KEY or SUPABASE_GATEWAY_KEY),
        },
        is_async=False,
    )


def observe(topic, raw, parts):
    """
    Offer one message to the capture in flight. Called from ingestion.on_message().

    NO-OP AND CHEAP WHEN NOTHING IS RECORDING, which is almost always. This runs on paho's network
    thread for every message the fleet publishes, so the idle path is one global read and a return.
    """
    job = _active
    if job is None:
        return
    if not job.matches(parts):
        return
    reason = job.append(topic, raw, parts[2])
    if reason:
        job.cap_reason = reason


def _claim():
    try:
        res = _supabase.rpc("ingest_claim_capture_job", {}).execute()
    except Exception as err:
        logger.warning("Capture: could not ask for queued jobs: %s", err)
        return None
    return res.data or None


def _begin(job_row):
    """Arm a claimed job, and ask the edge node to say who it is."""
    global _active
    state = _JobState(job_row)

    # THE BIRTH CERTIFICATE IS REQUESTED, NOT QUERIED, because nothing stores a raw birth payload:
    # `asset_config` holds birth PARAMETERS and `devices.last_birth_metrics` holds metric NAMES, and
    # neither can reconstruct a Sparkplug payload. What the daemon does have is its one permitted
    # publish. So a capture opens by asking the subject's edge node to rebirth, and the answer
    # arrives on the wire and is recorded as ordinary traffic.
    #
    # ARMED BEFORE THE REQUEST, necessarily: the NBIRTH can come back before the publish call
    # returns, and a buffer armed afterwards would miss the very message it asked for.
    _active = state

    if _rebirth is not None:
        try:
            # False means REBIRTH_REQUEST_INTERVAL_SECONDS has not elapsed since the last request to
            # this node. The recording still runs -- it simply may open without a birth, which
            # `birth_captured` then records honestly rather than the capture pretending otherwise.
            state.rebirth_requested = bool(_rebirth(state.group, state.edge_node))
        except Exception as err:
            logger.warning("Capture %s: rebirth request failed: %s", state.id, err)

    logger.info(
        "Capture %s started: %s on %s/%s, caps %ds / %d messages / %d bytes%s",
        state.id, state.device or "the whole edge node", state.group, state.edge_node,
        state.max_seconds, state.max_messages, state.max_bytes,
        "" if state.rebirth_requested else " (rebirth rate-limited; may open without a birth)",
    )
    return state


def _finish(state, reason):
    """Serialise, upload, and hand the artifact to the database. Clears the active job first."""
    global _active
    # CLEARED BEFORE THE BUFFER IS DRAINED, so observe() stops appending to a list that is about to
    # be serialised. A message arriving in between is dropped rather than half-recorded, which is
    # the right direction: the capture ends at a message boundary either way.
    _active = None
    messages = state.drain()

    if not messages:
        # An empty capture is almost always a credential, ACL or identity problem rather than a
        # quiet fleet, and storing the file anyway would defer that discovery to playback.
        _fail(state, (
            "recorded no messages from %s/%s%s. Either nothing published during the window, or the "
            "subject's ids do not match what is on the wire."
            % (state.group, state.edge_node,
               " for device " + state.device if state.device else "")
        ))
        return

    first = messages[0]["payload"].get("timestamp")
    capture_epoch_ms = int(first) if first is not None else int(time.time() * 1000)
    edge_nodes, devices = capture.capture_identities(messages)

    document = {
        "acs_capture_version": capture.CAPTURE_VERSION,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "recorded_from": {
            "broker": "%s:%d" % (capture.MQTT_HOST, capture.MQTT_PORT),
            # The topic this WOULD have been recorded with by the CLI, so a downloaded file reads
            # the same whichever path produced it.
            "topic": "spBv1.0/%s/+/%s%s" % (
                state.group, state.edge_node, "/" + state.device if state.device else "/#"),
        },
        "capture_epoch_ms": capture_epoch_ms,
        "duration_ms": messages[-1]["offset_ms"],
        "identities": {"edge_nodes": edge_nodes, "devices": devices},
        "messages": messages,
    }
    body = json.dumps(document, indent=2).encode("utf-8")

    try:
        # UPSERT, because each subject has exactly one capture object at a path derived from its
        # sparkplug id. Overwriting that key is what makes an orphaned file impossible -- and the
        # previous capture survives right up to this moment, so a recording that failed anywhere
        # above leaves the old one intact.
        _storage.from_(BUCKET).upload(
            path=state.storage_path,
            file=body,
            file_options={"content-type": "application/json", "upsert": "true"},
        )
    except Exception as err:
        # 42501 HERE IS THE FAILURE THIS WHOLE DESIGN IS SHAPED AROUND -- see 0051. It is reported
        # loudly and written to the job, because the alternative is a capture that recorded
        # perfectly and then never appeared, with nothing anywhere saying why.
        logger.error("Capture %s: upload to %s failed: %s", state.id, state.storage_path, err)
        _fail(state, "upload to %s failed: %s" % (state.storage_path, err))
        return

    manifest = _manifest(messages, state)
    try:
        _supabase.rpc("ingest_finalise_capture", {
            "p_job_id": state.id,
            "p_size_bytes": len(body),
            "p_message_count": len(messages),
            "p_manifest": manifest,
        }).execute()
    except Exception as err:
        logger.error("Capture %s: could not record the finished capture: %s", state.id, err)
        _fail(state, "the capture uploaded but could not be recorded: %s" % err)
        return

    logger.info(
        "Capture %s complete (%s): %d messages, %d bytes over %.1fs, birth_captured=%s",
        state.id, reason, len(messages), len(body), state.elapsed, state.birth_captured,
    )


def _manifest(messages, state):
    """
    What is in the file, so the page can describe a capture nobody has downloaded.

    `birth_captured` is the field that earns its place: it makes the alias trap visible on the list
    rather than something discovered when a playback ingests nothing. The metric names are capped
    by the database -- `capped_capture_manifest()` keeps 50 and records the true count beside them,
    the same cap `record_ingestion_rejection()` applies to violations and for the same reason.
    """
    names, topics = [], set()
    seen = set()
    # WHETHER THIS CAPTURE ACTUALLY DEPENDS ON THE ALIAS TABLE, which is what decides whether a
    # missing birth certificate costs anything. A metric carrying an `alias` and NO `name` can only
    # be resolved through the birth that defined it; one carrying its full name resolves on its own.
    # Recorded rather than assumed, because "no birth" and "will drop every metric" are not the same
    # claim -- this fleet publishes full names, so its birthless captures replay perfectly well.
    uses_aliases = False
    for m in messages:
        topics.add(m["topic"])
        for metric in m["payload"].get("metrics", []):
            name = metric.get("name")
            if not name and metric.get("alias") is not None:
                uses_aliases = True
            if name and name not in seen:
                seen.add(name)
                names.append(name)

    # THE IDENTITIES, SO PLAYBACK CAN BE SET UP WITHOUT DOWNLOADING THE FILE. Every captured device
    # id has to be mapped onto a device of the target gateway before a playback will start, and the
    # page builds that map from dropdowns -- so it needs to know which ids are in here. Without this
    # the dialog would have to fetch up to 100 MiB to populate a select.
    edge_nodes, devices = capture.capture_identities(messages)

    duration_s = max(messages[-1]["offset_ms"] / 1000.0, 0.001)
    return {
        "metric_names": names,
        "topic_count": len(topics),
        "observed_rate_hz": round(len(messages) / duration_s, 3),
        "birth_captured": state.birth_captured,
        "rebirth_requested": state.rebirth_requested,
        "edge_node_ids": edge_nodes,
        "device_ids": devices,
        "uses_aliases": uses_aliases,
    }


def _fail(state, message):
    try:
        _supabase.rpc("ingest_fail_capture", {
            "p_job_id": state.id, "p_error": message,
        }).execute()
    except Exception as err:
        logger.error("Capture %s: could not even record the failure: %s", state.id, err)
    logger.warning("Capture %s failed: %s", state.id, message)


def _tick(state):
    """One progress report. Returns the reason to stop, or None."""
    if state.cap_reason:
        return state.cap_reason
    if state.elapsed >= state.max_seconds:
        return "duration cap reached (%ds)" % state.max_seconds

    count, size, birth = state.snapshot()
    try:
        res = _supabase.rpc("ingest_capture_progress", {
            "p_job_id": state.id,
            "p_messages": count,
            "p_bytes": size,
            "p_elapsed_seconds": int(state.elapsed),
            "p_birth_captured": birth,
        }).execute()
    except Exception as err:
        # TRANSIENT AND SURVIVABLE. A progress tick that cannot reach Supabase means the card stops
        # moving; it does not mean the recording should be thrown away. The caps are enforced here
        # rather than by the database, so an unreachable Supabase cannot make a capture run forever.
        logger.warning("Capture %s: progress update failed: %s", state.id, err)
        return None

    if res.data is True:
        return "stopped by the operator"
    return None


def _loop():
    global _active
    while True:
        state = _active
        if state is None:
            row = _claim()
            if row:
                _begin(row)
            else:
                time.sleep(POLL_INTERVAL_SECONDS)
            continue

        time.sleep(PROGRESS_INTERVAL_SECONDS)
        try:
            reason = _tick(state)
        except Exception as err:
            # A bug in the tick must not take ingestion down with it, and must not leave a job
            # counting down forever either.
            logger.error("Capture %s: progress loop error: %s", state.id, err, exc_info=True)
            _active = None
            _fail(state, "progress loop error: %s" % err)
            continue

        if reason:
            try:
                _finish(state, reason)
            except Exception as err:
                logger.error("Capture %s: finalise error: %s", state.id, err, exc_info=True)
                _active = None
                _fail(state, "finalise error: %s" % err)


def reconcile(supabase):
    """
    Sweep jobs abandoned by a restart. Returns True if the sweep ran.

    NOT OPTIONAL, AND THE FAILURE IS TOTAL RATHER THAN COSMETIC. A job left at RECORDING has no
    buffer to resume, so without this the page shows a card counting down that never clears -- and,
    worse, the single-flight index still matches that row, so EVERY future capture on the stack is
    refused with nothing to point at. Nothing errors; the feature is simply dead until somebody
    finds the row by hand.

    WHICH IS WHY THE OUTCOME IS RETURNED RATHER THAN ONLY LOGGED. This used to be called exactly
    once, before the MQTT loop, and swallow its own failure -- so a Supabase that was not up yet
    left capture dead for the life of the process with a single ERROR line to show for it. That is
    not hypothetical: on a Docker daemon restart the containers come back in an order `depends_on`
    has no say over, and this lost that race. ingestion.py's startup healer retries until this
    returns True, and the boolean is how it knows.

    IDEMPOTENT, so retrying costs nothing: sweeping an empty set of abandoned jobs is a no-op.
    """
    try:
        res = supabase.rpc("ingest_reconcile_capture_jobs", {}).execute()
        swept = res.data or 0
        if swept:
            logger.warning(
                "Capture: %d job(s) were left in flight by a previous run and have been failed. "
                "Their recordings did not survive the restart.", swept,
            )
        return True
    except Exception as err:
        logger.error(
            "Capture: startup reconciliation failed: %s. A job abandoned by a restart would block "
            "every future capture, so this is worth fixing rather than ignoring.", err,
        )
        return False


def start(supabase, rebirth=None):
    """
    Run the capture worker. Returns True if startup reconciliation ran.

    `rebirth(group, edge_node) -> bool` requests a birth certificate.

    PASSED IN RATHER THAN IMPORTED. ingestion.py imports this module, so reaching back for
    `request_node_rebirth` would be a cycle -- and the callable keeps this module testable without
    a broker, a database or the daemon's module-level clients.
    """
    global _supabase, _storage, _rebirth
    _supabase = supabase
    _storage = _storage_client()
    _rebirth = rebirth
    reconciled = reconcile(supabase)
    threading.Thread(target=_loop, name="capture-worker", daemon=True).start()
    logger.info(
        "Capture worker running: polling for queued jobs every %.0fs, reporting progress every "
        "%.0fs, uploading to the %s bucket.",
        POLL_INTERVAL_SECONDS, PROGRESS_INTERVAL_SECONDS, BUCKET,
    )
    # The worker starts either way: it polls for NEW jobs, which is useful even while the abandoned
    # ones are still unswept. The caller retries the sweep.
    return reconciled
