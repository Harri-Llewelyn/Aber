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

A RESTART STORES THE RECORDING. ingestion.py's shutdown calls begin_shutdown() first and
finish_on_shutdown() last, once the historian's queue has drained. The recording takes what arrives
in between, then has one upload attempt in what the pod's grace period leaves.

Related: supabase/migrations/archive/0055_capture_orchestration.sql (the tables and every gate
         called here), 0190 (a path per recording, and deleting what nothing claims), capture.py
         (the file format, and the encoding preservation this reuses), README.md -> "Recording
         from the dashboard" (why the daemon hosts this, the two tables, and the three caps a job
         auto-terminates on).
"""

import io
import os
import re
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

# The calls that settle a job are retried this far apart before the job is kept for the loop to
# retry every UNSETTLED_RETRY_SECONDS: a job left RECORDING blocks every capture on the stack.
TERMINAL_RETRY_DELAYS = (1, 2, 4, 8, 16)
UNSETTLED_RETRY_SECONDS = float(os.getenv("CAPTURE_UNSETTLED_RETRY_SECONDS", "30"))

# A recording's upload is tried again this far apart, four attempts in all. Only a failure another
# attempt can cure is retried: no answer, or a 5xx or 429. Any other 4xx would be refused again.
UPLOAD_RETRY_DELAYS = (2, 4, 8)

# On a shutdown, the longest one write of a job's outcome may take. The upload leaves time for two:
# finalise, and the failure if finalise is refused.
SHUTDOWN_WRITE_SECONDS = 1.0
# A shutdown with less than this left for the upload does not start one.
SHUTDOWN_MIN_UPLOAD_SECONDS = 1.0

# The startup sweep spares a job another daemon may still be storing as it shuts down: a recording
# that reported, or a job queued, in the last 45 s (ingest_reconcile_capture_jobs()). The worker
# sweeps again this long after it starts, when any such job is past that, and fails what nothing
# stored.
RESWEEP_AFTER_SECONDS = 60

# How often an idle worker deletes the stored files nothing refers to, and how long one must have
# gone untouched first. A failed sweep is tried again after SWEEP_RETRY_SECONDS.
SWEEP_INTERVAL_SECONDS = float(os.getenv("CAPTURE_SWEEP_INTERVAL_SECONDS", "3600"))
SWEEP_MIN_AGE_SECONDS = int(os.getenv("CAPTURE_SWEEP_MIN_AGE_SECONDS", "3600"))
SWEEP_RETRY_SECONDS = 300
# ingest_unclaimed_capture_objects() answers at most this many; a full answer sweeps again soon.
SWEEP_BATCH = 500

# Finalise refused because the job is no longer RECORDING (22023) or no longer exists (23503): it
# was ended elsewhere, and retrying cannot store it.
_ENDED_ELSEWHERE = ("22023", "23503")

# Why a recording stopped, as the manifest records it.
STOP_DURATION = "duration"
STOP_OPERATOR = "operator"
STOP_MESSAGES = "message_cap"
STOP_SIZE = "size_cap"
STOP_RESTART = "restart"

# Node-level message types, which carry no device segment. A DEVICE capture records these too --
# see the matching rule in `_JobState.matches()`.
_NODE_TYPES = ("NBIRTH", "NDATA", "NDEATH")
# What sets birth_captured: a replay opens at the edge node's NBIRTH, and one without it is refused.
_BIRTH_TYPES = ("NBIRTH",)

# Sparkplug plumbing and identity, which are not the machine's metrics. ingestion.py holds the same
# identity list (IDENTITY_METRICS) and cannot be imported here: it imports this module.
_IDENTITY_METRICS = ("Asset_ID", "Asset_Name", "Instance_UUID", "Schema_UUID")

# A device's Instance_UUID on the wire, in any letter case: ingestion.py's UUID_PATTERN.
_UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def is_machine_metric(name):
    """False for bdSeq, Node Control/*, Device Control/* and the identity metrics."""
    return not (name == "bdSeq" or name.startswith(("Node Control/", "Device Control/"))
                or name in _IDENTITY_METRICS)


class _JobState:
    """The capture in flight. One at a time, enforced by a partial unique index in the database."""

    def __init__(self, job, reported_identity=None, reported_unread=False):
        self.job = job
        self.id = job["id"]
        # The gateway's configured group, from the job. Only the rebirth request uses it, and only
        # when ingestion has not recorded the group the node publishes under.
        self.group = job["sparkplug_group"]
        self.edge_node = job["edge_node_id"]
        # A device capture's subject, by its issued id. It is also recorded under the other ids
        # ingestion resolves it by: its own `reported_identity`, and its UUID in any letter case.
        self.device = job.get("device_sparkplug_id")
        uuid = job.get("device_id") if self.device else None
        self.device_uuid = uuid.lower() if uuid and _UUID_PATTERN.match(uuid) else None
        self.device_reported = None
        if self.device and reported_identity and reported_identity != self.device \
                and reported_identity.lower() != self.device_uuid:
            self.device_reported = reported_identity
        # The device row could not be read when the job started, so its own id is not listened for.
        self.reported_unread = bool(self.device and reported_unread)
        self.storage_path = job["storage_path"]
        # The subject's folder in the bucket: <subject>/<job id>.json.
        self.subject = self.storage_path.split("/")[0]
        self.max_seconds = int(job.get("max_seconds") or 7200)
        self.max_messages = int(job.get("max_messages") or 100000)
        self.max_bytes = int(job.get("max_bytes") or 52428800)

        # Each message as the file holds it (capture.message_line()), and the bytes they come to:
        # the buffer is the file's own bytes, and the size cap counts exactly what is written.
        self.lines = []
        self.bytes = 0
        self.count = 0
        # Set by drain(): the buffer is handed over, and nothing more is appended.
        self.closed = False
        # Set by observe() on the paho thread when a cap is met, read by the worker thread on its
        # next tick. The recording stops at a message boundary rather than mid-append.
        self.cap_reason = None
        self.cap_code = None
        # Seconds from the start to the stop, set when the recording ends.
        self.stopped_after = None
        # time.monotonic_ns() at the first message: offsets count from it.
        self.first_monotonic = None
        # What the file's head and the manifest say, kept as the messages arrive.
        self.epoch_ms = None
        self.last_offset_ms = 0
        self.edge_nodes = {}
        self.devices = {}
        self.topics = set()
        self.metric_names = {}
        self.uses_aliases = False
        self.device_published = False
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

        THE GROUP IS NOT COMPARED. Ingestion accepts an edge node under any group, by its
        sparkplug_id alone (unique site-wide), so a capture records the same traffic.

        A device-level message is the subject's under any id the device publishes behind its own
        edge node (`is_subject_device()`).
        """
        if len(parts) < 4 or parts[3] != self.edge_node:
            return False
        if self.device is None:
            return True
        if len(parts) < 5:
            # A node-level message on the subject's own edge node: the birth certificate and the
            # gateway heartbeats that frame it.
            return parts[2] in _NODE_TYPES
        return self.is_subject_device(parts[4])

    def is_subject_device(self, segment):
        """Is this topic device segment one of the ids the subject device publishes under?"""
        return (segment == self.device or segment == self.device_reported
                or (self.device_uuid is not None and segment.lower() == self.device_uuid))

    def listened_for(self):
        """The ids a device capture records its subject under, as the failure messages name them."""
        ids = ["the issued id %s" % self.device]
        if self.device_reported:
            ids.append("its own id %s" % self.device_reported)
        if self.device_uuid:
            ids.append("its UUID %s in any letter case" % self.device_uuid)
        said = ids[0] if len(ids) == 1 else "%s or %s" % (", ".join(ids[:-1]), ids[-1])
        if self.reported_unread:
            said += " (its own id, if it has one, could not be read when the recording started)"
        return said

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

        received_ms = int(time.time() * 1000)
        payload_dict = capture.payload_to_dict(payload)
        with self.lock:
            if self.closed:
                return None
            # Offsets from the monotonic clock, read in the order the lines are written, so the file
            # is in order by construction: the wall clock can step back, and the replay refuses
            # offsets that run backwards. The wall clock only dates the first message.
            now = time.monotonic_ns()
            if self.first_monotonic is None:
                self.first_monotonic = now
                self.epoch_ms = capture.first_message_epoch_ms(payload_dict, received_ms)
            self.last_offset_ms = (now - self.first_monotonic) // 1_000_000
            line = capture.message_line({
                "offset_ms": self.last_offset_ms,
                "topic": topic,
                "encoding": encoding,
                "payload": payload_dict,
            }, first=not self.count)
            self.lines.append(line)
            self.count += 1
            # The JSON as written, never the wire's length: protobuf grows several-fold as JSON.
            self.bytes += len(line)
            self._describe(topic, payload_dict)
            if msg_type in _BIRTH_TYPES:
                self.birth_captured = True

            # Closed at once: the tick that finishes the job is up to a second away, and a busy
            # edge node would otherwise carry the file that far past its cap.
            if self.count >= self.max_messages:
                self.cap_code = STOP_MESSAGES
                self.closed = True
                return "message cap reached (%d)" % self.max_messages
            if self.bytes >= self.max_bytes:
                self.cap_code = STOP_SIZE
                self.closed = True
                return "size cap reached (%d bytes)" % self.max_bytes
        return None

    def _describe(self, topic, payload_dict):
        """Note what the file's head and the manifest say about one message."""
        parts = topic.split("/")
        self.topics.add(topic)
        self.edge_nodes.setdefault(parts[3], None)
        if len(parts) > 4:
            self.devices.setdefault(parts[4], None)
            if self.device and self.is_subject_device(parts[4]):
                self.device_published = True
        for metric in payload_dict.get("metrics", ()):
            name = metric.get("name")
            if not name:
                # Resolved only through the birth that defined the alias.
                self.uses_aliases = self.uses_aliases or metric.get("alias") is not None
            elif name not in self.metric_names and is_machine_metric(name):
                self.metric_names[name] = None

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
            return self.count, self.bytes, self.birth_captured

    def drain(self):
        """Close the buffer and hand over its lines; what arrives later is not recorded."""
        with self.lock:
            self.closed = True
            lines, self.lines = self.lines, []
            return lines


class _CaptureFile(io.RawIOBase):
    """
    A capture file read from its parts in order, so an upload streams the recorded lines without
    joining them into a second copy. Seekable, so the client can take its length.
    """

    def __init__(self, parts):
        super().__init__()
        self._parts = parts
        self.size = sum(len(part) for part in parts)
        self._seek_to(0)

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self._pos

    def seek(self, offset, whence=io.SEEK_SET):
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self.size}[whence]
        self._seek_to(min(max(base + offset, 0), self.size))
        return self._pos

    def _seek_to(self, pos):
        self._pos, self._index, self._offset = pos, 0, pos
        if pos == self.size:
            self._index, self._offset = len(self._parts), 0
            return
        while self._offset >= len(self._parts[self._index]):
            self._offset -= len(self._parts[self._index])
            self._index += 1

    def readinto(self, buffer):
        view = memoryview(buffer).cast("B")
        written = 0
        while written < len(view) and self._index < len(self._parts):
            part = self._parts[self._index]
            n = min(len(view) - written, len(part) - self._offset)
            view[written:written + n] = memoryview(part)[self._offset:self._offset + n]
            written += n
            self._offset += n
            if self._offset == len(part):
                self._index, self._offset = self._index + 1, 0
        self._pos += written
        return written


# The active job, or None. Read on the paho thread by observe() and written by the worker thread;
# a bare attribute assignment is atomic in CPython, which is all the coordination this needs -- the
# buffer itself is guarded by the job's own lock.
_active = None
_supabase = None
_storage = None
_rebirth = None
# A finished job whose failure could not be written yet: (state, message, uploaded). The loop
# retries it before claiming anything else, so the job never drops out of view.
_unsettled = None
# When the idle loop next deletes the stored files nothing refers to (time.monotonic()).
_next_sweep = 0.0

# Set by begin_shutdown(). From then the worker claims and finishes nothing itself, and a wait
# between attempts ends at once; the shutdown stores the recording in flight.
_stopping = threading.Event()
# When the shutdown's capture work must be done (time.monotonic()), set with _stopping.
_shutdown_deadline = None
# Held by whoever arms or finishes the active job, the worker or the shutdown, so one finishes it.
_finishing = threading.Lock()
# The job the worker is finishing, for a shutdown that cannot wait for it to end.
_finishing_state = None
# When the idle loop sweeps abandoned jobs a second time (time.monotonic()), or None once it has.
_resweep_at = None


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


def _reported_identity(device_id):
    """
    The id a device reported as its own (None when it has none), and whether the read failed. A
    failed read is not retried: the capture still records the device under its issued id and UUID.
    """
    try:
        res = _supabase.table("devices").select("reported_identity").eq("id", device_id).execute()
    except Exception as err:
        logger.warning("Capture: could not read device %s's own id, so its capture listens only "
                       "for its issued id and its UUID: %s", device_id, err)
        return None, True
    rows = res.data or []
    return (rows[0].get("reported_identity") if rows else None), False


def _begin(job_row):
    """Arm a claimed job, and ask the edge node to say who it is."""
    global _active
    reported, unread = None, False
    if job_row.get("device_sparkplug_id") and job_row.get("device_id"):
        reported, unread = _reported_identity(job_row["device_id"])
    state = _JobState(job_row, reported_identity=reported, reported_unread=unread)

    # THE BIRTH CERTIFICATE IS REQUESTED, NOT QUERIED, because nothing stores a raw birth payload:
    # `asset_config` holds birth PARAMETERS and `devices.last_birth_metrics` holds metric NAMES, and
    # neither can reconstruct a Sparkplug payload. What the daemon does have is its one permitted
    # publish. So a capture opens by asking the subject's edge node to rebirth, and the answer
    # arrives on the wire and is recorded as ordinary traffic.
    #
    # ARMED BEFORE THE REQUEST, necessarily: the NBIRTH can come back before the publish call
    # returns, and a buffer armed afterwards would miss the very message it asked for. Under the
    # lock the shutdown takes the active job with, so a job claimed as it begins is not left behind.
    with _finishing:
        if _stopping.is_set():
            _settle_failure(state, "the ingestion service restarted as the recording began, so "
                                   "nothing was recorded. Record it again.")
            return None
        _active = state

    if _rebirth is not None:
        try:
            # The request is forced past the throttle, so False means it could not be published.
            # The recording still runs, and `birth_captured` says whether a birth arrived anyway.
            state.rebirth_requested = bool(_rebirth(state.group, state.edge_node))
        except Exception as err:
            logger.warning("Capture %s: rebirth request failed: %s", state.id, err)

    logger.info(
        "Capture %s started: %sedge node %s, caps %ds / %d messages / %d bytes%s",
        state.id, "device %s (%s) on " % (state.device, state.listened_for()) if state.device else "",
        state.edge_node,
        state.max_seconds, state.max_messages, state.max_bytes,
        "" if state.rebirth_requested
        else " (the rebirth request could not be published; it may record no birth)",
    )
    return state


def _finish(state, reason, stop=None, deadline=None):
    """
    Upload the recording to the job's own path, and hand the capture to the database.

    The active job is cleared and the buffer closed before the upload, so the capture ends at a
    message boundary. The file streams from the recorded lines, which are its bytes. The previous
    capture of the subject is untouched until finalise repoints the row, and its file is deleted
    only after that.

    With a `deadline` (time.monotonic()) this is the shutdown's finish: one upload attempt, every
    step inside the deadline, and a failure that says the restart stopped it.
    """
    global _active
    _active = None
    state.stopped_after = state.elapsed
    lines = state.drain()

    refusal = _nothing_recorded(state)
    if refusal:
        if deadline is not None:
            refusal = "the ingestion service restarted during the recording, which " + refusal
        _settle_failure(state, refusal, deadline=deadline)
        return

    # A device capture's subject, by the id it was heard under.
    heard = next((d for d in state.devices if state.is_subject_device(d)), None) \
        if state.device else None
    head = capture.file_head({
        "aber_capture_version": capture.CAPTURE_VERSION,
        "recorded_at": datetime.now(timezone.utc).isoformat(),
        "recorded_from": {
            "broker": "%s:%d" % (capture.MQTT_HOST, capture.MQTT_PORT),
            # The topic `capture.py record` would have used, so the file reads the same either way.
            "topic": "spBv1.0/+/+/%s%s" % (state.edge_node, "/" + heard if heard else "/#"),
        },
        # The first message's own clock, or its receipt: the offsets count from that receipt.
        "capture_epoch_ms": state.epoch_ms,
        "duration_ms": state.last_offset_ms,
        "identities": {"edge_nodes": list(state.edge_nodes), "devices": list(state.devices)},
    })
    parts = [head] + lines + [capture.FILE_TAIL]
    size = sum(len(part) for part in parts)
    del lines

    failure = _upload(state, parts, deadline)
    # The buffer goes before the job is settled, which may retry for half a minute.
    del parts
    if failure is not None:
        # Written to the job: a capture that recorded and never appeared must say why.
        logger.error("Capture %s: %s", state.id, failure)
        _settle_failure(state, failure, uploaded=True, deadline=deadline)
        return

    manifest = _manifest(state, stop)
    try:
        _call("ingest_finalise_capture", {
            "p_job_id": state.id,
            "p_size_bytes": size,
            "p_message_count": state.count,
            "p_manifest": manifest,
        }, deadline)
    except Exception as err:
        if _code(err) in _ENDED_ELSEWHERE:
            logger.warning(
                "Capture %s was ended outside the recorder before it could be stored (%s). Its file "
                "is discarded; any earlier capture of the subject is unchanged.", state.id, err)
            _tidy(state.subject, deadline)
        else:
            logger.error("Capture %s: could not record the finished capture: %s", state.id, err)
            if _within(deadline) is not None:
                message = _restart_failure("it uploaded but could not be recorded: %s" % err)
            else:
                message = ("the capture uploaded but could not be recorded: %s. Any earlier "
                           "capture of the subject is unchanged." % err)
            _settle_failure(state, message, uploaded=True, deadline=deadline)
        return

    # The row now names this capture's file; the one it replaced is unclaimed and goes now.
    _tidy(state.subject, deadline)
    logger.info(
        "Capture %s complete (%s): %d messages, %d bytes over %.1fs, birth_captured=%s",
        state.id, reason, state.count, size, state.stopped_after, state.birth_captured,
    )


def _upload_once(state, parts):
    """One upload of the file to the job's own path, so it never writes over the capture it may
    replace. Upsert, so a retried upload of the same path succeeds. A fresh reader each time: the
    client closes the one it was given."""
    _storage.from_(BUCKET).upload(
        path=state.storage_path,
        file=io.BufferedReader(_CaptureFile(parts), buffer_size=1 << 16),
        file_options={"content-type": "application/json", "upsert": "true"},
    )


def _upload(state, parts, deadline=None):
    """
    Upload the file. Returns None once it is stored, or what the job's failure should say.

    A failure another attempt can cure is tried again after each of UPLOAD_RETRY_DELAYS, and the
    last error is the one reported. A shutdown that begins meanwhile ends the wait for one last
    attempt inside its deadline; with a deadline given, that one attempt is all there is.
    """
    deadline = _within(deadline)
    if deadline is not None:
        return _upload_before(state, parts, deadline)
    attempt, last = 0, None
    for delay in UPLOAD_RETRY_DELAYS + (None,):
        attempt += 1
        try:
            _upload_once(state, parts)
            return None
        except Exception as err:
            last = err
        if delay is None or not _retryable(last):
            break
        logger.warning("Capture %s: upload attempt %d of %d failed, trying again in %ss: %s",
                       state.id, attempt, len(UPLOAD_RETRY_DELAYS) + 1, delay, _said(last))
        if _pause(delay):
            return _upload_before(state, parts, _shutdown_deadline)
    return "upload to %s failed%s: %s" % (
        state.storage_path, " after %d attempts" % attempt if attempt > 1 else "", _said(last))


def _upload_before(state, parts, deadline):
    """The shutdown's one upload attempt, in what is left before `deadline`. None, or the failure."""
    seconds = deadline - time.monotonic() - 2 * SHUTDOWN_WRITE_SECONDS
    if seconds < SHUTDOWN_MIN_UPLOAD_SECONDS:
        return _restart_failure("its shutdown had no time left to upload it")
    logger.info("Capture %s: uploading to %s before the daemon exits, with %.1fs to do it in.",
                state.id, state.storage_path, seconds)
    try:
        _bounded(seconds, lambda: _upload_once(state, parts))
    except _OutOfTime:
        return _restart_failure("the upload to %s it tried as it shut down did not finish in the "
                                "%.1fs it had" % (state.storage_path, seconds))
    except Exception as err:
        return _restart_failure("the upload to %s it tried as it shut down failed: %s"
                                % (state.storage_path, _said(err)))
    return None


def _restart_failure(what):
    """A failure written during a shutdown. It names the restart, where reconcile on the next start
    could say only that the recording did not survive."""
    return ("the ingestion service restarted before the recording was stored, and %s. Nothing was "
            "stored; any earlier capture of the subject is unchanged." % what)


def _retryable(err):
    """
    Whether another attempt could cure an upload's failure: no answer (refused, reset, timed out),
    or an answer of 5xx or 429. storage3 raises its own error from httpx's, so the cause chain is
    read, and the HTTP status wins over the one Storage put in its body.
    """
    try:
        import httpx
        transport = (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)
    except ImportError:
        transport = ()
    transport += (ConnectionError, TimeoutError)
    chain = _chain(err)
    statuses = [s for s in map(_http_status, chain) if s is not None] \
        or [s for s in map(_body_status, chain) if s is not None]
    if statuses:
        return statuses[0] == 429 or statuses[0] >= 500
    return any(isinstance(e, transport) for e in chain)


def _chain(err):
    """An error and the ones it was raised from or during, outermost first."""
    chain, seen = [], set()
    while err is not None and id(err) not in seen:
        seen.add(id(err))
        chain.append(err)
        err = err.__cause__ or err.__context__
    return chain


def _said(err):
    """An upload's error as the job's failure says it. An answer storage3 could not read, such as
    the gateway's own 503, is named by its HTTP status rather than by the parse error alone."""
    status = next((s for s in map(_http_status, _chain(err)) if s is not None), None)
    if status is None or _body_status(err) is not None:
        return str(err)
    return "HTTP %d (%s)" % (status, err)


def _http_status(err):
    """The status of the HTTP response an error carries (httpx.HTTPStatusError), or None."""
    code = getattr(getattr(err, "response", None), "status_code", None)
    return code if isinstance(code, int) else None


def _body_status(err):
    """The status Storage wrote in its answer's body (storage3's StorageApiError.status), or None."""
    try:
        return int(getattr(err, "status", None))
    except (TypeError, ValueError):
        return None


def _pause(seconds):
    """Wait between attempts. True when a shutdown has begun, which ends the wait at once."""
    return _stopping.wait(seconds)


class _OutOfTime(Exception):
    """A shutdown's step that did not return in the time it had."""


def _bounded(seconds, fn):
    """
    fn() on a thread of its own, waited for at most `seconds`: its result, its exception, or
    _OutOfTime. A step left running is abandoned to the process exit, which is moments away.
    """
    box = {}

    def run():
        try:
            box["value"] = fn()
        except BaseException as err:  # noqa: BLE001 -- handed to the caller below
            box["error"] = err

    thread = threading.Thread(target=run, name="capture-shutdown", daemon=True)
    thread.start()
    thread.join(max(seconds, 0.0))
    if thread.is_alive():
        raise _OutOfTime("did not finish in %.1fs" % max(seconds, 0.0))
    if "error" in box:
        raise box["error"]
    return box.get("value")


def _within(deadline):
    """The deadline a step must meet: the one given, or a shutdown's once one has begun, or None."""
    if deadline is not None:
        return deadline
    return _shutdown_deadline if _stopping.is_set() else None


def _tidy(subject, deadline=None):
    """_remove_unclaimed() under one subject. A shutdown gives it only the time left, and the hourly
    sweep deletes what it leaves."""
    deadline = _within(deadline)
    if deadline is None:
        _remove_unclaimed(subject)
        return
    try:
        _bounded(deadline - time.monotonic(), lambda: _remove_unclaimed(subject))
    except _OutOfTime:
        logger.info("Capture: no time before the exit to delete the files under %s/ that nothing "
                    "refers to; the hourly sweep does.", subject)


def _nothing_recorded(state):
    """Why there is nothing worth storing, or None. Either way the stored capture is kept."""
    if not state.count:
        # An empty capture is almost always a credential, ACL or identity problem rather than a
        # quiet fleet, and storing the file anyway would defer that discovery to playback.
        return (
            "recorded no messages from edge node %s, in any Sparkplug group%s. Either nothing "
            "published during the window, or the subject's ids do not match what is on the wire."
            % (state.edge_node, ", and none from device %s under %s" % (
                state.device, state.listened_for()) if state.device else "")
        )
    # A device capture keeps its edge node's NBIRTH, which the capture's own rebirth request always
    # produces, so only a message carrying the device's segment shows the device published.
    if state.device and not state.device_published:
        return (
            "recorded nothing from device %s: only %d message(s) from its edge node %s arrived, and "
            "none under %s. Check that the device is switched on and publishing under one of "
            "those ids, then record again. The stored capture of this device is unchanged."
            % (state.device, state.count, state.edge_node, state.listened_for())
        )
    return None


def _manifest(state, stop=None):
    """
    What is in the file, so the page can describe a capture nobody has downloaded.

    `birth_captured` says an NBIRTH was recorded; playback refuses a capture without one.
    `metric_names` leaves out Sparkplug plumbing and identity, and the database keeps the first 50
    with the true count beside them (`capped_capture_manifest()`). The identities let the playback
    dialog map devices without the file. `stop_reason` and `duration_ms` say whether the recording
    ran its window or a cap cut it short.
    """
    duration_s = max(state.last_offset_ms / 1000.0, 0.001)
    elapsed = state.stopped_after if state.stopped_after is not None else state.elapsed
    return {
        "metric_names": list(state.metric_names),
        "topic_count": len(state.topics),
        "observed_rate_hz": round(state.count / duration_s, 3),
        "birth_captured": state.birth_captured,
        "rebirth_requested": state.rebirth_requested,
        "edge_node_ids": list(state.edge_nodes),
        "device_ids": list(state.devices),
        "uses_aliases": state.uses_aliases,
        "stop_reason": stop,
        "duration_ms": int(elapsed * 1000),
        "requested_seconds": state.max_seconds,
    }


def _code(err):
    """The PostgREST or Postgres code an exception carries, as a string, or ''."""
    return str(getattr(err, "code", "") or "")


def _call(name, args, deadline=None):
    """
    One gate call, retried with backoff. A refusal saying the job ended elsewhere is not. Inside a
    shutdown it is tried once, for at most SHUTDOWN_WRITE_SECONDS and never past the deadline.
    """
    for delay in TERMINAL_RETRY_DELAYS + (None,):
        within = _within(deadline)
        if within is not None:
            seconds = min(SHUTDOWN_WRITE_SECONDS, within - time.monotonic())
            return _bounded(seconds, lambda: _supabase.rpc(name, args).execute())
        try:
            return _supabase.rpc(name, args).execute()
        except Exception as err:
            if delay is None or _code(err) in _ENDED_ELSEWHERE:
                raise
            logger.warning("Capture: %s failed, trying again in %ss: %s", name, delay, err)
            _pause(delay)
    return None


def _settle_failure(state, message, uploaded=False, deadline=None):
    """
    Record the job as failed. Returns True once written.

    When even the retries fail the job is kept in `_unsettled`, and the loop retries it before
    claiming anything else; Stop on the page ends it meanwhile once its progress is stale. Inside a
    shutdown there is one attempt, and a job it cannot write is failed by the next start's reconcile.
    """
    global _unsettled
    try:
        _call("ingest_fail_capture", {"p_job_id": state.id, "p_error": message}, deadline)
    except Exception as err:
        if _within(deadline) is not None:
            logger.error("Capture %s: could not record its failure before the daemon exits (%s); "
                         "the next start fails it as abandoned. It was: %s", state.id, err, message)
            return False
        logger.error(
            "Capture %s: could not record its failure (%s); trying again every %.0fs. Until then "
            "the job reads as recording and no other capture can start.",
            state.id, err, UNSETTLED_RETRY_SECONDS)
        _unsettled = (state, message, uploaded)
        return False
    _unsettled = None
    logger.warning("Capture %s failed: %s", state.id, message)
    if uploaded:
        # Its file is unclaimed now the job is not RECORDING.
        _tidy(state.subject, deadline)
    return True


def settle_unsettled():
    """One more attempt at the failure the worker could not write. True when nothing is left."""
    if _unsettled is None:
        return True
    state, message, uploaded = _unsettled
    return _settle_failure(state, message, uploaded)


def _remove_unclaimed(subject=None, min_age_seconds=0):
    """
    Delete the stored files nothing refers to, under one subject or anywhere. Returns how many the
    database named, or None on failure.

    Through the Storage API, because only it removes the bytes: a DELETE of the storage.objects
    row in SQL leaves the file in the storage backend. The bucket's DELETE policy admits the daemon
    to an unclaimed object alone, so a file a row, a recording, an open upload or a playback names
    survives whatever this is asked.
    """
    where = " under %s/" % subject if subject else ""
    try:
        res = _supabase.rpc("ingest_unclaimed_capture_objects", {
            "p_subject": subject, "p_min_age_seconds": int(min_age_seconds),
        }).execute()
        names = list(res.data or [])
        if names:
            _storage.from_(BUCKET).remove(names)
            logger.info("Capture: deleted %d stored file(s)%s that nothing refers to any more.",
                        len(names), where)
        return len(names)
    except Exception as err:
        logger.warning("Capture: could not delete the stored files nothing refers to%s: %s. The "
                       "hourly sweep tries again.", where, err)
        return None


def sweep():
    """The idle loop's hourly pass over the whole bucket. Returns when the next is due."""
    removed = _remove_unclaimed(None, SWEEP_MIN_AGE_SECONDS)
    if removed is None:
        return time.monotonic() + SWEEP_RETRY_SECONDS
    if removed >= SWEEP_BATCH:
        return time.monotonic() + POLL_INTERVAL_SECONDS
    return time.monotonic() + SWEEP_INTERVAL_SECONDS


def _report(state):
    """continue, stop, ended or gone: what the database says about the job."""
    count, size, birth = state.snapshot()
    args = {
        "p_job_id": state.id,
        "p_messages": count,
        "p_bytes": size,
        "p_elapsed_seconds": int(state.elapsed),
        "p_birth_captured": birth,
    }
    try:
        return _supabase.rpc("ingest_report_capture_progress", args).execute().data
    except Exception as err:
        # PGRST202: the database predates the gate (db-init runs after the daemon on an upgrade).
        # The older gate answers true for stop, ended and gone alike.
        if _code(err) != "PGRST202":
            raise
        return "stop" if _supabase.rpc("ingest_capture_progress", args).execute().data is True \
            else "continue"


def _tick(state):
    """
    One progress report. Returns None to go on, ("finish", reason, stop) to store the capture, or
    ("discard", answer) when the job ended elsewhere or no longer exists.
    """
    if state.cap_reason:
        return ("finish", state.cap_reason, state.cap_code)
    if state.elapsed >= state.max_seconds:
        return ("finish", "duration cap reached (%ds)" % state.max_seconds, STOP_DURATION)

    try:
        answer = _report(state)
    except Exception as err:
        # Transient: the card stops moving, and the recording goes on. The caps are enforced here,
        # so an unreachable Supabase cannot make a capture run for ever.
        logger.warning("Capture %s: progress update failed: %s", state.id, err)
        return None

    if answer == "stop":
        return ("finish", "stopped by the operator", STOP_OPERATOR)
    if answer in ("ended", "gone"):
        return ("discard", answer)
    return None


def _discard(state, answer):
    """Drop a recording whose job is gone. Nothing is uploaded: there is no job to upload for."""
    global _active
    _active = None
    state.drain()
    if answer == "gone":
        logger.warning("Capture %s: its job no longer exists, because its subject was deleted while "
                       "it recorded. The recording is discarded.", state.id)
    else:
        logger.warning("Capture %s: its job was ended outside the recorder (cancelled from the page, "
                       "or swept). The recording is discarded.", state.id)


def _loop():
    """The worker thread. It ends once a shutdown has begun, which then owns the job in flight."""
    global _next_sweep, _resweep_at
    while not _stopping.is_set():
        if _unsettled is not None:
            time.sleep(UNSETTLED_RETRY_SECONDS)
            settle_unsettled()
            continue

        state = _active
        if state is None:
            if _resweep_at is not None and time.monotonic() >= _resweep_at:
                ran = reconcile(_supabase)
                _resweep_at = None if ran else time.monotonic() + UNSETTLED_RETRY_SECONDS
            if time.monotonic() >= _next_sweep:
                _next_sweep = sweep()
            row = _claim()
            if row:
                _begin(row)
            else:
                time.sleep(POLL_INTERVAL_SECONDS)
            continue

        time.sleep(PROGRESS_INTERVAL_SECONDS)
        try:
            outcome = _tick(state)
        except Exception as err:
            outcome = ("error", err)
        if outcome is not None:
            _end(state, outcome)


def _end(state, outcome):
    """Act on a tick's outcome, unless a shutdown has begun: then the shutdown finishes the job."""
    global _active, _finishing_state
    with _finishing:
        if _stopping.is_set() or _active is not state:
            return
        _finishing_state = state
        try:
            if outcome[0] == "discard":
                _discard(state, outcome[1])
            elif outcome[0] == "error":
                # A bug in the tick must not take ingestion down, nor leave a job counting for ever.
                logger.error("Capture %s: progress loop error: %s", state.id, outcome[1],
                             exc_info=outcome[1])
                _active = None
                _settle_failure(state, "progress loop error: %s" % outcome[1])
            else:
                try:
                    _finish(state, outcome[1], outcome[2])
                except Exception as err:
                    logger.error("Capture %s: finalise error: %s", state.id, err, exc_info=True)
                    _active = None
                    _settle_failure(state, "finalise error: %s" % err, uploaded=True)
        finally:
            _finishing_state = None


def begin_shutdown(deadline):
    """
    The daemon is shutting down and must be done by `deadline` (time.monotonic()). From now the
    worker claims and finishes nothing itself. A recording in flight goes on recording what still
    arrives until finish_on_shutdown(); an upload waiting to be retried makes its last attempt now.
    """
    global _shutdown_deadline
    _shutdown_deadline = deadline
    _stopping.set()


def finish_on_shutdown():
    """
    Store the recording in flight as Stop would, with one upload attempt in the time the shutdown
    has left. Returns True when a job was finished here. With nothing recording, nothing changes.

    A job this cannot store is FAILED with a message that names the restart.
    """
    global _active
    if _shutdown_deadline is None:
        begin_shutdown(time.monotonic())
    deadline = _shutdown_deadline
    # The worker may be storing a recording of its own: wait for it, leaving time to fail it.
    if not _finishing.acquire(timeout=max(deadline - time.monotonic() - SHUTDOWN_WRITE_SECONDS, 0)):
        state = _finishing_state
        if state is not None:
            _settle_failure(state, _restart_failure(
                "its upload was still running when the shutdown's time ran out"),
                uploaded=True, deadline=deadline)
        return False
    try:
        state = _active
        if state is None:
            if _unsettled is not None:
                settle_unsettled()
            return False
        stop = state.cap_code or (STOP_DURATION if state.elapsed >= state.max_seconds
                                  else STOP_RESTART)
        logger.info("Capture %s: the daemon is shutting down, so the recording stops here.",
                    state.id)
        try:
            _finish(state, "stopped by a restart", stop, deadline)
        except Exception as err:
            logger.error("Capture %s: finalise error: %s", state.id, err, exc_info=True)
            _active = None
            _settle_failure(state, _restart_failure("its finish failed: %s" % err),
                            uploaded=True, deadline=deadline)
        return True
    finally:
        _finishing.release()


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

    IDEMPOTENT, so retrying costs nothing: sweeping an empty set of abandoned jobs is a no-op. It
    spares a job another daemon may still be storing, so the idle loop sweeps once more after
    RESWEEP_AFTER_SECONDS.
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

    `rebirth(group, edge_node) -> bool` requests a birth certificate. `group` is the job's configured
    group; the callable addresses the request to the group the node publishes under.

    PASSED IN RATHER THAN IMPORTED. ingestion.py imports this module, so reaching back for
    `request_node_rebirth` would be a cycle -- and the callable keeps this module testable without
    a broker, a database or the daemon's module-level clients.
    """
    global _supabase, _storage, _rebirth, _resweep_at
    _supabase = supabase
    _storage = _storage_client()
    _rebirth = rebirth
    reconciled = reconcile(supabase)
    _resweep_at = time.monotonic() + RESWEEP_AFTER_SECONDS
    threading.Thread(target=_loop, name="capture-worker", daemon=True).start()
    logger.info(
        "Capture worker running: polling for queued jobs every %.0fs, reporting progress every "
        "%.0fs, uploading to the %s bucket.",
        POLL_INTERVAL_SECONDS, PROGRESS_INTERVAL_SECONDS, BUCKET,
    )
    # The worker starts either way: it polls for NEW jobs, which is useful even while the abandoned
    # ones are still unswept. The caller retries the sweep.
    return reconciled
