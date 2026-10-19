"""
Publishing a stored capture back into the stack, as a simulated gateway.

TWO IDENTITIES, AND THAT SPLIT IS THE ARRANGEMENT TO UNDERSTAND FIRST.

  SUPABASE     `Service_Playback` (0056). Reads the queue, reads the capture, writes status.
               Fixed, and the same for every job.
  MQTT         THE TARGET GATEWAY'S OWN ACCOUNT -- username equals its `sparkplug_id`. Per job,
               and supplied as a secret the way `MQTT_VALIDATOR_USER` is.

One says what this may do in the database; the other says what the broker will carry, which is what
confines a playback to one edge node with no ACL change at all: a worker connected as `gwyAAA...`
cannot publish under `gwyBBB...`, because the broker drops it before any subscriber sees it.

A SEPARATE PROCESS, NOT THE INGESTION DAEMON, because that principal is the one the whole ACL is
built around and publishing asset data would widen it. This process only PUBLISHES and holds no
subscription, so it takes nothing from the daemon's view of the stream.

THIS DECIDES NOTHING ABOUT WHETHER A PLAYBACK IS ALLOWED. `start_playback_job()` has already refused
a target that is not `is_simulated`, one holding no broker credential, and a device map naming
another gateway's devices. This refuses one further thing -- a target it holds no MQTT password for
-- and otherwise carries out what it is given. The publishing is `capture.py`'s `plan_playback()`,
which decides every topic, payload and delay with no broker and no clock, so this file is a loop
that cannot make a new decision.

Related: supabase/migrations/archive/0056_playback_orchestration.sql (every gate called here),
         capture.py (the plan, the identity rewrite, the rebasing),
         README.md -> "Playback from the dashboard" (the three tiers of confinement, how one %u
         rule confines every gateway, and what a failed playback looks like).
"""

import json
import os
import threading
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

import capture
from logging_config import get_logger

# `get_logger`, not `logging.getLogger(__name__)`: this stack configures NAMED loggers with
# `propagate = False`, so a module logger made the standard-library way has no handler and its INFO
# lines are discarded. (docs/incidents.md -- "A worker that logged nothing looked like one nobody
# had asked for")
logger = get_logger("playback")

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
SUPABASE_PLAYBACK_KEY = os.getenv("SUPABASE_PLAYBACK_KEY", "")
# The publishable key, presented as `apikey`; the gateway translates it (docs/gateway.md).
SUPABASE_GATEWAY_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")

BUCKET = os.getenv("CAPTURE_BUCKET", "broker-captures")
POLL_INTERVAL_SECONDS = float(os.getenv("PLAYBACK_POLL_INTERVAL_SECONDS", "3"))
PROGRESS_INTERVAL_SECONDS = float(os.getenv("PLAYBACK_PROGRESS_INTERVAL_SECONDS", "1"))
# The longest single sleep while a job waits for its next message. request_playback_stop() treats a
# job silent for a minute as stalled, so this stays far below that.
SLEEP_SLICE_SECONDS = 1.0
# How long playback_finish() is retried, with backoff, before the row is left RUNNING for Stop or
# the next startup sweep to end.
FINISH_RETRY_SECONDS = float(os.getenv("PLAYBACK_FINISH_RETRY_SECONDS", "300"))

# How long to wait for the broker's CONNACK before failing the job.
#
# GENEROUS ON PURPOSE. This is a broker in the same cluster, where the answer arrives
# in milliseconds, and the cost of waiting is paid once per job rather than per message. Five
# seconds is long enough that a loaded host does not produce a spurious failure, and short enough
# that an operator watching a job does not read the pause as the playback having started.
CONNACK_TIMEOUT_SECONDS = float(os.getenv("PLAYBACK_CONNACK_TIMEOUT_SECONDS", "5"))

# How long a session's NDEATH may wait for its PUBACK before the connection is dropped instead, so
# the broker delivers the Will.
NDEATH_ACK_TIMEOUT_SECONDS = 5.0

# The bdSeq the next CONNECT as each gateway carries: 0 for this process's first, then one more for
# every CONNECT sent, wrapping 255 to 0 (tck-id-topics-nbirth-bdseq-increment).
_next_bdseq = {}

# The heartbeat: how often a timer thread restates which gateways this worker can publish as, while
# idle and during a job. The playback dialog reads a report older than two minutes as a worker that
# is not running.
CREDENTIAL_REPORT_INTERVAL_SECONDS = float(
    os.getenv("PLAYBACK_CREDENTIAL_REPORT_INTERVAL_SECONDS", "30")
)



MQTT_HOST = os.getenv("MQTT_HOST", "mosquitto")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))

# Where the credential service drops passwords for Playback (is_shadow) gateways (0078, 0183).
#
# THE FILE EXISTS BECAUSE THE ENVIRONMENT CANNOT BE RE-READ. A container's environment is fixed at
# creation, so a newly-issued password reaches a running worker only through a file it can re-read.
#
# WRITTEN ONLY FOR GATEWAYS THE DATABASE CALLS PLAYBACK TARGETS. The filter is applied at issue time
# by gateway_is_playback_delivery_target() (0183), not here, because `is_shadow` is the
# database's fact and a worker deciding which passwords it is allowed to have would be deciding its
# own blast radius. This end only reads what it was given.
#
# THE STRING IS DUPLICATED IN scripts/lib/mosquitto-credentials.mjs, which is the writer, and twice
# more in the chart -- the mount and the Secret key projected into it. Python and JavaScript cannot
# share a constant, and a mismatch is silent at BOTH ends -- the write succeeds and the read finds
# nothing -- so scripts/check-docs-drift.mjs asserts all four agree.
PLAYBACK_CREDENTIAL_FILE = os.getenv(
    "PLAYBACK_CREDENTIAL_FILE", "/var/lib/aber/playback/credentials.json"
)


def _file_credentials(path=None):
    """
    The delivered credentials, or an empty map if none have been.

    ABSENT IS NORMAL AND IS NOT AN ERROR, and absent has two forms: no file at all, and a file with
    nothing in it -- which is what the chart's Secret projection presents until something has been
    delivered. Unreadable or malformed IS an error, because that is a delivery that happened and did
    not arrive. (docs/incidents.md -- "An empty credential file is the normal state, and reading it
    as malformed logged forever")
    """
    path = path or PLAYBACK_CREDENTIAL_FILE
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = handle.read()
    except FileNotFoundError:
        return {}
    except OSError as err:
        logger.error(
            "Could not read the playback credential file at %s (%s). Credentials issued from the "
            "Gateways page will not reach this worker until it is readable.", path, err,
        )
        return {}

    # EMPTY IS ABSENT, and on a cluster it is the ONLY form absent takes. The chart creates
    # `playback_credentials.json` as a key of the broker's credential Secret on every install and
    # the projection mounts it whether or not anything has been delivered, so the file a fresh
    # stack presents is blank rather than missing.
    if not raw.strip():
        return {}

    try:
        parsed = json.loads(raw)
    except ValueError as err:
        logger.error(
            "The playback credential file at %s is not valid JSON (%s), so no delivered credential "
            "can be used. Expected {\"gwy...\": \"password\"}.", path, err,
        )
        return {}

    if not isinstance(parsed, dict):
        logger.error(
            "The playback credential file at %s is not a JSON object, so no delivered credential "
            "can be used. Expected {\"gwy...\": \"password\"}.", path,
        )
        return {}
    return {str(k): str(v) for k, v in parsed.items()}


def _credentials():
    """
    The broker passwords this worker holds, keyed by gateway `sparkplug_id`.

    TIER TWO OF THREE, AND THE ONLY ONE THAT LIVES OUTSIDE THE DATABASE. The job gate refuses a
    target that is not `is_simulated`; the broker ACL confines whatever connects to its own edge
    node; and this is the middle one -- the worker simply cannot authenticate as a gateway whose
    password it was not given, so a compromised queue cannot make it publish as a real machine.

    THREE SOURCES, THE DELIVERED FILE WINNING. Issuing a credential for an `is_shadow` gateway
    delivers its password to PLAYBACK_CREDENTIAL_FILE (archived migration 0078), re-read every pass.
    MQTT_PLAYBACK_CREDENTIALS (the chart's `secrets.mqttPlaybackCredentials`) carries passwords
    supplied by hand, as a JSON map because playback has as many identities as it has targets.
    MQTT_PLAYBACK_USER / MQTT_PLAYBACK_PASSWORD, the pair `capture.py play` reads, is a
    single-target fallback.

    NOT LOGGED, EVER. The keys are gateway ids and are safe; the values are broker passwords.
    """
    raw = os.getenv("MQTT_PLAYBACK_CREDENTIALS", "").strip()
    credentials = {}
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                credentials = {str(k): str(v) for k, v in parsed.items()}
            else:
                logger.error(
                    "MQTT_PLAYBACK_CREDENTIALS is not a JSON object, so no playback target has a "
                    "credential. Expected {\"gwy...\": \"password\"}."
                )
        except ValueError as err:
            logger.error(
                "MQTT_PLAYBACK_CREDENTIALS is not valid JSON (%s), so no playback target has a "
                "credential.", err,
            )

    user = os.getenv("MQTT_PLAYBACK_USER", "").strip()
    password = os.getenv("MQTT_PLAYBACK_PASSWORD", "")
    if user and password and user not in credentials:
        credentials[user] = password

    # THE DELIVERED FILE WINS, and the reason is the broker rather than a preference about
    # configuration. Mosquitto holds ONE password per username, so issuing a credential REPLACES the
    # one before it -- which means a value in the environment is not an alternative to the delivered
    # one, it is an OLDER one, and after any re-issue it is simply wrong. Letting the environment
    # override would make the documented repair for a refused playback ("issue a new credential")
    # the one thing that could not fix it.
    credentials.update(_file_credentials())
    return credentials


def _supabase():
    from supabase import create_client
    client = create_client(SUPABASE_URL, SUPABASE_GATEWAY_KEY)
    # `.auth()` on the PostgREST sub-client, which is the ONLY thing this pattern authenticates --
    # ingestion.py records at length that setting the session header instead silently sends the
    # gateway key. The storage client is built separately below for exactly that reason.
    client.postgrest.auth(SUPABASE_PLAYBACK_KEY)
    # 'service': what log_audit_trail_event() files a machine identity as, whatever it declares.
    client.postgrest.session.headers["X-Aber-Actor"] = "service"
    return client


def _storage():
    """
    A storage client authenticating as the worker, not as `anon`.

    THE SHARED CLIENT WOULD READ AS `anon` AND SAY NOTHING ABOUT IT. `client.storage` keeps the key
    it was constructed with; only the PostgREST sub-client is re-authenticated.
    (docs/incidents.md -- "A storage client that quietly read as `anon`")
    """
    from storage3 import create_client as create_storage_client
    return create_storage_client(
        # TRAILING SLASH: storage3 warns and corrects it otherwise, and a UserWarning on every boot
        # is noise that trains a reader to skip the startup lines.
        SUPABASE_URL.rstrip("/") + "/storage/v1/",
        {
            "apikey": SUPABASE_GATEWAY_KEY,
            "Authorization": "Bearer " + (SUPABASE_PLAYBACK_KEY or SUPABASE_GATEWAY_KEY),
        },
        is_async=False,
    )


class _SessionState:
    """What paho's network thread learns about one connection, read by the publishing loop."""

    def __init__(self):
        # Every CONNACK return code, in order; empty until the broker answers.
        self.connack = []
        # Set when the connection drops without this worker asking.
        self.lost = threading.Event()
        self.lost_rc = None

    def on_connect(self, _client, _userdata, _flags, rc, *_args):
        self.connack.append(rc)

    def on_disconnect(self, _client, _userdata, rc, *_args):
        if rc != 0:
            self.lost_rc = rc
            self.lost.set()


def _connect(edge_node_id, password, will_topic, will_payload):
    """
    Connect AS the target gateway: its `sparkplug_id` is the username. Returns at the TCP handshake;
    the CONNACK arrives later on paho's thread and is recorded on `client.aber`, never raised there.
    """
    client = mqtt.Client(client_id="aber-playback-%s" % edge_node_id)
    client.username_pw_set(edge_node_id, password)
    # The session's NDEATH as the Will, QoS 1 and not retained, so a worker that dies mid-replay is
    # announced too (tck-id-payloads-ndeath-will-message, -will-message-qos, -will-message-retain).
    client.will_set(will_topic, will_payload, qos=1, retain=False)
    client.aber = _SessionState()
    client.on_connect = client.aber.on_connect
    client.on_disconnect = client.aber.on_disconnect
    if os.getenv("MQTT_TLS_ENABLED", "").strip().lower() in ("1", "true", "yes", "on"):
        import ssl
        ca = os.getenv("MQTT_TLS_CA_FILE", "").strip()
        client.tls_set(ca_certs=ca or None, cert_reqs=ssl.CERT_REQUIRED,
                       tls_version=ssl.PROTOCOL_TLS_CLIENT)
    client.connect(MQTT_HOST, MQTT_PORT, 60)
    return client


def _open_session(edge_node, password, will_topic, bdseq):
    """
    One Sparkplug session as the target gateway: CONNECT with the NDEATH for `bdseq` as its Will,
    then wait for the CONNACK. Returns (client, None), or (None, the reason the job fails).
    """
    try:
        client = _connect(edge_node, password, will_topic,
                          capture.node_death(bdseq, int(time.time() * 1000)))
    except Exception as err:
        return None, "could not connect to the broker as %s: %s" % (edge_node, err)

    # The CONNECT carrying this bdSeq was sent, whatever the broker answers.
    _next_bdseq[edge_node] = (bdseq + 1) % 256
    client.loop_start()

    # ------------------------------------------------------------------------------------------
    # THE BROKER HAS TO ACCEPT US BEFORE A SINGLE MESSAGE IS COUNTED AS SENT. The credential check
    # in _run_job refuses a MISSING password and cannot see a WRONG one, which is what a re-issued
    # credential leaves behind until its delivery reaches this worker.
    #
    # rc 4 and 5 are the two that mean the password: 4 is bad username/password, 5 is not
    # authorised. They are named rather than lumped in, because they are the ones an operator fixes
    # by issuing a credential rather than by looking at the broker.
    deadline = time.monotonic() + CONNACK_TIMEOUT_SECONDS
    while not client.aber.connack and time.monotonic() < deadline:
        time.sleep(0.05)

    if not client.aber.connack:
        client.loop_stop()
        return None, (
            "the broker never answered the connection as %s within %ss. It is reachable at %s:%s "
            "or this would have failed above, so it accepted the socket and said nothing."
            % (edge_node, CONNACK_TIMEOUT_SECONDS, MQTT_HOST, MQTT_PORT)
        )

    rc = client.aber.connack[0]
    if rc != 0:
        client.loop_stop()
        detail = {
            4: "the broker rejected the username or password",
            5: "the broker refused this connection as not authorised",
        }.get(rc, "the broker refused the connection")
        return None, (
            "%s for %s (CONNACK rc=%s), so the password this worker holds is not the one the "
            "broker has. A credential issued for this gateway reaches the worker within about a "
            "minute: if one was just issued, start the playback again then; otherwise issue a new "
            "one from the gateway's drawer on the Gateways page (Generate Broker Credential)."
            % (detail, edge_node, rc)
        )
    return client, None


def _end_session(client, topic, death):
    """
    End a session as an intentional disconnect: the NDEATH at QoS 1, acknowledged, then DISCONNECT,
    which tells the broker to discard the Will
    (tck-id-operational-behavior-edge-node-intentional-disconnect-ndeath,
    tck-id-payloads-ndeath-will-message-publisher-disconnect-mqtt311). A death the broker has not
    acknowledged is left to the Will: the socket is closed without DISCONNECT.
    """
    acked = False
    try:
        info = client.publish(topic, death, qos=1, retain=False)
        info.wait_for_publish(NDEATH_ACK_TIMEOUT_SECONDS)
        acked = info.is_published()
    except Exception as err:
        logger.warning("Could not publish the NDEATH on %s: %s", topic, err)
    client.loop_stop()
    if acked:
        try:
            client.disconnect()
        except Exception:
            pass
        return
    logger.warning("The broker did not acknowledge the NDEATH on %s; closing the connection "
                   "without DISCONNECT, so the broker publishes the Will instead.", topic)
    sock = client.socket()
    if sock is not None:
        sock.close()


def _connection_lost(sent):
    """The job's error when the broker connection drops mid-replay."""
    return (
        "publishing stopped after %d message(s): the broker connection was lost. Re-issuing this "
        "gateway's credential or restarting the broker ends a playback's connection; start the "
        "playback again." % sent
    )


class _Stopped(Exception):
    """The operator asked to stop, or the job's row is no longer RUNNING."""


class _JobFailed(Exception):
    """The job ends FAILED with this message."""


class _Progress:
    """A job's count, reported to `playback_progress()`, whose answer may stop the job."""

    def __init__(self, supabase, job_id, total):
        self.supabase = supabase
        self.job_id = job_id
        self.total = total
        self.sent = 0
        self.started = None
        self._last = None
        self._warned = None

    def report(self, force=False):
        """Report now if forced, on the first call, or once PROGRESS_INTERVAL_SECONDS has passed.
        Raises _Stopped when the answer says to stop."""
        now = time.monotonic()
        if not force and self._last is not None and now - self._last < PROGRESS_INTERVAL_SECONDS:
            return
        self._last = now
        elapsed = int(now - self.started) if self.started is not None else 0
        try:
            stop = self.supabase.rpc("playback_progress", {
                "p_job_id": self.job_id,
                "p_messages_sent": self.sent,
                "p_messages_total": self.total,
                "p_elapsed_seconds": elapsed,
            }).execute().data is True
        except Exception as err:
            # The card stops moving; the playback does not. Logged at most every 30 seconds.
            if self._warned is None or now - self._warned >= 30:
                self._warned = now
                logger.warning("Playback %s: progress update failed: %s", self.job_id, err)
            return
        if stop:
            raise _Stopped()


def _wait_until(target, progress, client):
    """
    Sleep until `target` (time.monotonic()) in slices of at most SLEEP_SLICE_SECONDS, reporting
    progress after each, so Stop and a lost connection end a long gap within a slice.
    """
    while True:
        remaining = target - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(SLEEP_SLICE_SECONDS, remaining))
        if client is not None and client.aber.lost.is_set():
            raise _JobFailed(_connection_lost(progress.sent))
        progress.report(force=True)


def _run_job(supabase, storage, credentials, job, outcome=None):
    """
    Publish one capture. Returns (messages_sent, messages_out_of_window, error or None); sets
    outcome["stopped"] when the operator stopped it.
    """
    job_id = job["id"]
    edge_node = job["target_edge_node_id"]
    password = credentials.get(edge_node)

    if not password:
        # REFUSED HERE RATHER THAN ATTEMPTED. Without a password the connect fails with a broker
        # error that names neither the gateway nor the missing secret, and at QoS 0 a publish that
        # the ACL refuses is dropped with no PUBACK -- so a wrong-credential playback would
        # otherwise report success and move nothing.
        return 0, 0, (
            "this worker holds no broker credential for %s, so it cannot authenticate as that "
            "gateway. Issue one from the gateway's drawer on the Gateways page (Generate Broker "
            "Credential): it reaches this worker within about a minute, with no restart." % edge_node
        )

    # ------------------------------------------------------------------------------------------
    # The capture
    # ------------------------------------------------------------------------------------------
    try:
        body = storage.from_(BUCKET).download(job["capture_storage_path"])
    except Exception as err:
        # 42501 here is the read gate: `Service_Playback` holds telemetry:read alone (0080), and the bucket's SELECT
        # policy admits it only for the object of a RUNNING job. If this fails on a job that IS
        # running, the policy arm is missing rather than the file.
        return 0, 0, "could not read %s: %s" % (job["capture_storage_path"], err)

    try:
        document = json.loads(body.decode("utf-8") if isinstance(body, bytes) else body)
    except ValueError as err:
        return 0, 0, "%s is not valid JSON: %s" % (job["capture_storage_path"], err)

    # ------------------------------------------------------------------------------------------
    # The plan
    # ------------------------------------------------------------------------------------------
    # EVERYTHING THAT CAN BE WRONG IS DECIDED HERE, with no broker and no clock -- an unmapped
    # device, a rebasing that lands outside the daemon's sanity window, a malformed topic. The
    # publishing loop below cannot make a new decision, which is what makes a dry run and a real
    # run the same computation.
    play_epoch_ms = int(time.time() * 1000)
    speed = float(job.get("speed") or 1.0)
    device_map = job.get("device_map") or {}
    bdseq = _next_bdseq.get(edge_node, 0)
    try:
        plan = capture.plan_playback(
            document, edge_node, device_map, play_epoch_ms, speed=speed,
            group=job.get("sparkplug_group"), bdseq=bdseq,
        )
    except capture.CaptureError as err:
        return 0, 0, str(err)

    # DECIDED BEFORE PUBLISHING, not discovered after. The daemon's answer to an out-of-window
    # metric is a counter, not an error, and nothing travels back to the publisher -- so a playback
    # every one of whose timestamps the daemon will discard would otherwise publish its whole
    # capture, be recorded COMPLETED with the full `messages_sent`, and write nothing.
    #
    # REFUSED ONLY WHEN IT CAN WRITE NOTHING AT ALL (#216). The split is the point:
    #
    #   * nothing survives the window -- a total no-op, which is never what anyone wanted. Refused
    #     here, which makes it FAILED with this reason, which the Capture page already shows.
    #   * something does -- run it. A capture carrying one stale device clock is still worth
    #     replaying, and only the operator can say whether this one is. The count goes onto the job
    #     row so the page says what was lost instead of reporting an unqualified success.
    #
    # COUNTED PER MESSAGE, DECIDED PER METRIC, AND THE TWO ARE DIFFERENT QUESTIONS. The daemon
    # judges each metric on its own timestamp and falls back to the payload's only when it has none,
    # so a capture whose every message loses one reading and keeps another writes plenty. Refusing
    # on `len(lossy) >= len(plan)` would report that one as having written nothing.
    #
    # `capture.py play` refuses BOTH cases unless --allow-unsane is passed, and that difference is
    # deliberate rather than an oversight: the CLI has an escape hatch to pass and a person at a
    # terminal to read the message, and the page has neither.
    lossy, metrics_kept, metrics_dropped = capture.window_outcome(plan, play_epoch_ms)
    out_of_window = len(lossy)
    if metrics_dropped and not metrics_kept:
        topic, ts, at = lossy[0]
        return 0, out_of_window, (
            "every one of the %d reading(s) in this capture carries a timestamp the ingestion "
            "daemon will discard as too old or too far in the future, so this playback would "
            "publish the whole capture and write nothing to the historian (first: %s, stamped %s, "
            "would be sent at %s). %s" % (
                metrics_dropped, topic,
                datetime.fromtimestamp(ts / 1000.0, timezone.utc).isoformat(),
                datetime.fromtimestamp(at / 1000.0, timezone.utc).isoformat(),
                capture.window_explanation(speed),
            )
        )
    if lossy:
        logger.warning(
            "Playback %s: %d of %d message(s) carry timestamps the daemon will drop as too old or "
            "too far in the future. They will be published and silently discarded on ingest.",
            job_id, out_of_window, len(plan),
        )

    # ------------------------------------------------------------------------------------------
    # Publishing
    # ------------------------------------------------------------------------------------------
    # Every planned topic is under the job's group, so the first names the edge node's.
    will_topic = "spBv1.0/%s/NDEATH/%s" % (capture.split_topic(plan[0][1])[0], edge_node)
    client, error = _open_session(edge_node, password, will_topic, bdseq)
    if error:
        return 0, out_of_window, error

    progress = _Progress(supabase, job_id, len(plan))
    progress.started = time.monotonic()

    try:
        for delay_ms, topic, payload_bytes, _ in plan:
            # An absolute schedule: per-message sleeps would drift by every publish and progress
            # call, and the rebased timestamps would drift out of window with them.
            _wait_until(progress.started + delay_ms / 1000.0, progress, client)

            if client is None:
                client, error = _open_session(edge_node, password, will_topic, bdseq)
                if error:
                    raise _JobFailed("publishing stopped after %d message(s): %s"
                                     % (progress.sent, error))

            if client.aber.lost.is_set():
                raise _JobFailed(_connection_lost(progress.sent))
            if capture.split_topic(topic)[1] == "NDEATH":
                # A recorded death ends the session as it ended the recorded node's. The plan
                # numbered the messages after it as the next session, which opens on the next one.
                _end_session(client, topic, payload_bytes)
                client = None
                bdseq = (bdseq + 1) % 256
            else:
                # QoS 0, as the fleet publishes: only paho's acceptance is observable, so a message
                # counts once paho has accepted it on a connection that has not dropped.
                info = client.publish(topic, payload_bytes, qos=0, retain=False)
                if info.rc != mqtt.MQTT_ERR_SUCCESS:
                    raise _JobFailed(_connection_lost(progress.sent))
            progress.sent += 1
            progress.report()
    except _Stopped:
        logger.info("Playback %s: stopped by the operator after %d message(s).",
                    job_id, progress.sent)
        if outcome is not None:
            outcome["stopped"] = True
    except _JobFailed as err:
        error = str(err)
    except Exception as err:
        error = "publishing stopped after %d message(s): %s" % (progress.sent, err)
    finally:
        # However it ended, an open session ends with its NDEATH, so the gateway reads OFFLINE.
        if client is not None:
            _end_session(client, will_topic, capture.node_death(bdseq, int(time.time() * 1000)))

    return progress.sent, out_of_window, error


class _Holdings:
    """
    The broker passwords this worker holds, and the heartbeat that reports them.

    The main loop re-reads the sources every pass (refresh()); a timer thread reports what is held
    every CREDENTIAL_REPORT_INTERVAL_SECONDS and at once after a change, whether or not a job is
    running, so a long playback does not read as a worker that stopped. Ids only, never passwords:
    `playback_worker_status` is readable by three roles.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._changed = threading.Event()
        self.credentials = _credentials()
        # Gateways with a password picked up since the last report that got through. Everything
        # counts at startup: the sources were just read.
        self._rotated = set(self.credentials)

    def refresh(self):
        """Re-read the sources, log a change by gateway id, and wake the heartbeat for it."""
        current = _credentials()
        with self._lock:
            previous, self.credentials = self.credentials, current
            if current == previous:
                return current
            gained = sorted(set(current) - set(previous))
            lost = sorted(set(previous) - set(current))
            # A re-issue keeps the id and changes the password, so maps are compared, not key sets.
            rotated = sorted(k for k in set(current) & set(previous) if current[k] != previous[k])
            self._rotated.update(gained)
            self._rotated.update(rotated)
            self._rotated.difference_update(lost)
        parts = []
        if gained:
            parts.append("gained %s" % ", ".join(gained))
        if rotated:
            parts.append("rotated %s" % ", ".join(rotated))
        if lost:
            parts.append("lost %s" % ", ".join(lost))
        logger.info("Playback credentials changed: now holding %d gateway(s) -- %s.",
                    len(current), "; ".join(parts) or "no change to which gateways are held")
        self._changed.set()
        return current

    def report(self, supabase):
        """One heartbeat. A rotation is cleared only once a report carrying it got through."""
        with self._lock:
            held = sorted(self.credentials)
            rotated = sorted(self._rotated)
        supabase.rpc("playback_report_credentials", {
            "p_edge_nodes": held,
            "p_rotated": rotated,
        }).execute()
        with self._lock:
            self._rotated.difference_update(rotated)

    def run_heartbeat(self, supabase, stop=None):
        """The timer thread's body. A failed report is logged and retried on the next beat."""
        stop = stop or threading.Event()
        while not stop.is_set():
            self._changed.clear()
            try:
                self.report(supabase)
            except Exception as err:
                logger.warning("Could not report held credentials: %s", err)
            self._changed.wait(CREDENTIAL_REPORT_INTERVAL_SECONDS)


def _start_heartbeat(holdings):
    """The heartbeat on its own thread and its own Supabase client."""
    thread = threading.Thread(target=holdings.run_heartbeat, args=(_supabase(),),
                              name="playback-heartbeat", daemon=True)
    thread.start()
    return thread


def _sweep(supabase):
    """
    Fail the jobs a previous run left in flight. Returns whether the sweep ran. Nothing is claimed
    until it has: a row left RUNNING blocks its target, and a sweep after a claim would fail the
    job just claimed.
    """
    try:
        swept = supabase.rpc("playback_reconcile_jobs", {}).execute().data or 0
    except Exception as err:
        logger.error("Startup reconciliation failed: %s. No playback is started until it succeeds; "
                     "retrying every %.0fs.", err, POLL_INTERVAL_SECONDS)
        return False
    if swept:
        logger.warning("%d playback job(s) were left in flight by a previous run and have been "
                       "failed. Whatever they had published is already in the historian.", swept)
    return True


def _finish(supabase, job, sent, error, out_of_window):
    """
    Record the end of a job, retrying with backoff for FINISH_RETRY_SECONDS. Returns whether it was
    recorded. A row left RUNNING is ended by Stop once its progress is a minute old, or by the next
    startup sweep.
    """
    params = {
        "p_job_id": job["id"], "p_messages_sent": sent, "p_error": error,
        "p_messages_out_of_window": out_of_window,
    }
    deadline = time.monotonic() + FINISH_RETRY_SECONDS
    delay = 1.0
    attempt = 1
    while True:
        try:
            supabase.rpc("playback_finish", params).execute()
            if attempt > 1:
                logger.info("Playback %s: its end was recorded at attempt %d.", job["id"], attempt)
            return True
        except Exception as err:
            if time.monotonic() + delay > deadline:
                logger.error(
                    "Playback %s finished but could not be recorded after %d attempt(s) (%s). The "
                    "row stays RUNNING and blocks playbacks onto %s until Stop is pressed on the "
                    "Capture page or this worker restarts.",
                    job["id"], attempt, err, job["target_edge_node_id"],
                )
                return False
            logger.warning("Playback %s: could not record its end (%s); retrying in %.0fs.",
                           job["id"], err, delay)
        time.sleep(delay)
        delay = min(delay * 2, 30.0)
        attempt += 1


def main():
    if not SUPABASE_PLAYBACK_KEY:
        logger.critical(
            "CRITICAL CONFIGURATION ERROR: SUPABASE_PLAYBACK_KEY is not set. This worker "
            "authenticates as Service_Playback (archived migration 0056) and every gate it calls checks "
            "that the caller IS that principal, so without this key it can claim nothing and would "
            "sit polling an empty queue forever while looking healthy. `npm run setup` mints "
            "it (secrets.playbackKey)."
        )
        raise SystemExit(1)

    supabase = _supabase()
    storage = _storage()
    holdings = _Holdings()

    if not holdings.credentials:
        # Not fatal: a stack that has issued no playback credential yet is correctly configured.
        logger.warning(
            "This worker holds no playback credentials yet, so every job will be refused for want "
            "of an identity to publish as. Issuing a broker credential for a simulated gateway "
            "(Gateways page, Generate Broker Credential) delivers it here, and the worker picks it "
            "up without a restart."
        )
    else:
        logger.info("Playback worker holds credentials for %d gateway(s): %s",
                    len(holdings.credentials), ", ".join(sorted(holdings.credentials)))

    _start_heartbeat(holdings)
    logger.info(
        "Playback worker running: polling every %.0fs, publishing to %s:%d.",
        POLL_INTERVAL_SECONDS, MQTT_HOST, MQTT_PORT,
    )

    swept = False
    while True:
        # Re-read every pass: a credential issued from the Gateways page arrives in the file while
        # this runs, and a snapshot from boot would refuse every job until a restart.
        credentials = holdings.refresh()

        if not swept:
            swept = _sweep(supabase)
            if not swept:
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

        try:
            job = supabase.rpc("playback_claim_job", {}).execute().data
        except Exception as err:
            logger.warning("Could not ask for queued playbacks: %s", err)
            time.sleep(POLL_INTERVAL_SECONDS)
            continue

        if not job:
            time.sleep(POLL_INTERVAL_SECONDS)
            continue

        logger.info(
            "Playback %s started: %s onto %s at %sx, %d device mapping(s).",
            job["id"], job["capture_storage_path"], job["target_edge_node_id"],
            job.get("speed"), len(job.get("device_map") or {}),
        )
        outcome = {}
        try:
            sent, out_of_window, error = _run_job(supabase, storage, credentials, job,
                                                  outcome=outcome)
        except Exception as err:
            logger.error("Playback %s: unhandled error: %s", job["id"], err, exc_info=True)
            sent, out_of_window, error = 0, 0, "unhandled error: %s" % err

        if not _finish(supabase, job, sent, error, out_of_window):
            continue

        if error:
            logger.warning("Playback %s failed after %d message(s): %s", job["id"], sent, error)
        else:
            logger.info("Playback %s complete: %d message(s) published as %s.",
                        job["id"], sent, job["target_edge_node_id"])


if __name__ == "__main__":
    main()
