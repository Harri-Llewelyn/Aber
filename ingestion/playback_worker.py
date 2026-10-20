"""
Publishing a stored capture back into the stack as the Playback gateway, a full Sparkplug edge node.

Two identities: Supabase as `Service_Playback` (the queue, the capture, the job's status), and
MQTT as the target gateway itself, username its `sparkplug_id`, which the broker's %u rule confines
to that edge node. `start_playback_job()` decides whether a playback is allowed; `capture.py`'s
`plan_playback()` decides every topic, payload and delay. This carries the plan out as one or more
Sparkplug sessions: it subscribes to the node's NCMD and answers a rebirth request, waits for the
primary host's STATE before each NBIRTH and ends the job when it goes offline, counts only what paho
accepted, and ends every session with its NDEATH.

README.md -> "Playback from the dashboard" and the sections after it hold the reasons.
"""

import json
import os
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

import capture
import sparkplug_b_pb2
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
# A capture is downloaded, and read back, this much at a time.
DOWNLOAD_CHUNK_BYTES = 1 << 20
DOWNLOAD_TIMEOUT_SECONDS = 60
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

# The Sparkplug primary host application, the ingestion daemon, whose STATE every NBIRTH waits for;
# the chart passes ingestion.primaryHostId. Empty: no wait, as for a node with no primary host.
PRIMARY_HOST_ID = os.getenv("PRIMARY_HOST_ID", "").strip()
# How long a session waits for that STATE to say online before the job fails.
PRIMARY_HOST_WAIT_SECONDS = float(os.getenv("PLAYBACK_PRIMARY_HOST_WAIT_SECONDS", "60"))

REBIRTH_METRIC = "Node Control/Rebirth"

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


DELIVERED, HELM, ENVIRONMENT = "delivered", "helm", "environment"

# What each source is called in a job's error and the log. Never the password.
SOURCE_NAMES = {
    DELIVERED: "the delivered password",
    HELM: "the password in secrets.mqttPlaybackCredentials",
    ENVIRONMENT: "the password in MQTT_PLAYBACK_PASSWORD",
}


def _credential_sources():
    """
    Every broker password this worker holds, as {gateway sparkplug_id: [(source, password), ...]}
    in the order to try them: the delivered file, then the Helm value (MQTT_PLAYBACK_CREDENTIALS,
    a JSON map), then the MQTT_PLAYBACK_USER / MQTT_PLAYBACK_PASSWORD pair. A password two sources
    agree on is listed once. The worker cannot authenticate as a gateway it holds none for.

    Delivered first because issuing replaces the broker's one password per gateway, so a delivery
    is normally the newest. The Helm value is the fallback the credential dialog gives when a
    delivery failed, so the connect path tries it when the broker refuses the delivered one.
    Passwords are never logged.
    """
    helm = {}
    raw = os.getenv("MQTT_PLAYBACK_CREDENTIALS", "").strip()
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                helm = {str(k): str(v) for k, v in parsed.items()}
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
    pair = {}
    user = os.getenv("MQTT_PLAYBACK_USER", "").strip()
    password = os.getenv("MQTT_PLAYBACK_PASSWORD", "")
    if user and password:
        pair[user] = password

    sources = {}
    for source, held in ((DELIVERED, _file_credentials()), (HELM, helm), (ENVIRONMENT, pair)):
        for gateway, secret in held.items():
            candidates = sources.setdefault(gateway, [])
            if secret and all(secret != known for _, known in candidates):
                candidates.append((source, secret))
    return {gateway: candidates for gateway, candidates in sources.items() if candidates}


def _credentials():
    """
    The password tried first for each gateway: {sparkplug_id: password}. Tier two of three: the
    worker cannot authenticate as a gateway whose password it was not given (README.md).
    """
    return {gateway: candidates[0][1] for gateway, candidates in _credential_sources().items()}


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
    return _CaptureStore()


class _CaptureStore:
    """
    Reads a capture from the bucket into a file, a chunk at a time, as the worker and not as
    `anon`: the bearer is the playback key (docs/incidents.md -- "A storage client that quietly
    read as `anon`"). The storage client's own download returns the object whole, joined from
    its chunks, which is two copies of the file in memory.
    """

    def __init__(self):
        self._objects = SUPABASE_URL.rstrip("/") + "/storage/v1/object/"
        self._headers = {
            "apikey": SUPABASE_GATEWAY_KEY,
            "Authorization": "Bearer " + (SUPABASE_PLAYBACK_KEY or SUPABASE_GATEWAY_KEY),
        }

    def download_to(self, path, sink):
        """Write the object at `path` into the binary file `sink`."""
        url = self._objects + urllib.parse.quote("%s/%s" % (BUCKET, path))
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=self._headers),
                                        timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
                length = response.headers.get("Content-Length")
                shutil.copyfileobj(response, sink, DOWNLOAD_CHUNK_BYTES)
        except urllib.error.HTTPError as err:
            raise RuntimeError(_storage_refusal(err)) from None
        if length and length.isdigit() and sink.tell() != int(length):
            raise RuntimeError("the download stopped after %d of %s bytes" % (sink.tell(), length))


def _storage_refusal(err):
    """What storage-api said, from its JSON error body when it sent one."""
    try:
        body = json.loads(err.read().decode("utf-8"))
        detail = "%s: %s" % (body.get("error"), body.get("message"))
    except Exception:
        detail = err.reason
    return "HTTP %s %s" % (err.code, detail)


class _SessionState:
    """
    What paho's network thread learns about one connection: the CONNACK and SUBACK, a dropped
    connection, a rebirth request on the node's NCMD topic, and the primary host's STATE.
    """

    def __init__(self, ncmd_topic=None, state_topic=None):
        self.ncmd_topic = ncmd_topic
        self.state_topic = state_topic
        # Every CONNACK return code, in order; empty until the broker answers.
        self.connack = []
        self.subacks = {}
        # Set when the connection drops without this worker asking.
        self.lost = threading.Event()
        self.lost_rc = None
        self.rebirth = threading.Event()
        self._host_lock = threading.Lock()
        self.host_online = None
        self.host_timestamp = None
        # Set by a valid offline STATE; cleared once the host has been seen online before a birth.
        self.host_left = threading.Event()

    def on_connect(self, _client, _userdata, _flags, rc, *_args):
        self.connack.append(rc)

    def on_disconnect(self, _client, _userdata, rc, *_args):
        if rc != 0:
            self.lost_rc = rc
            self.lost.set()

    def on_subscribe(self, _client, _userdata, mid, granted, *_args):
        self.subacks[mid] = tuple(granted)

    def on_message(self, _client, _userdata, message):
        if self.state_topic and message.topic == self.state_topic:
            self._on_state(message.payload)
        elif message.topic == self.ncmd_topic and _asks_for_rebirth(message.payload):
            self.rebirth.set()

    def _on_state(self, raw):
        # The topic is subscribed exactly, so its last token is the configured host id
        # (tck-id-message-flow-edge-node-birth-publish-phid-wait-id). A STATE older than the last
        # one seen is ignored (-phid-wait-timestamp); the first is taken as it is.
        state = _host_state(raw)
        if state is None:
            return
        online, stamp = state
        with self._host_lock:
            if self.host_timestamp is not None and stamp < self.host_timestamp:
                return
            self.host_timestamp = stamp
            self.host_online = online
        if not online:
            self.host_left.set()


def _host_state(raw):
    """A STATE payload as (online, timestamp), or None when it is not one (JSON, both keys)."""
    try:
        data = json.loads(raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
        online, stamp = data["online"], data["timestamp"]
    except (ValueError, KeyError, TypeError, AttributeError):
        return None
    if not isinstance(online, bool) or isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
        return None
    return online, stamp


def _asks_for_rebirth(raw):
    """Whether an NCMD carries `Node Control/Rebirth` = true, read as the daemon reads a payload."""
    try:
        payload, _ = capture.decode_wire_payload(raw)
    except Exception:
        return False
    return any(m.name == REBIRTH_METRIC and m.HasField("boolean_value") and m.boolean_value
               for m in payload.metrics)


def _with_seq(raw, seq):
    """
    The same wire payload with its `seq` replaced, in the encoding it is in: protobuf first, then
    JSON, as capture.decode_wire_payload() reads it.
    """
    payload = sparkplug_b_pb2.Payload()
    try:
        payload.ParseFromString(raw)
    except Exception:
        data = json.loads(raw.decode("utf-8"))
        data["seq"] = seq
        return json.dumps(data, separators=(",", ":")).encode("utf-8")
    payload.seq = seq
    return payload.SerializeToString()


def _connect(edge_node_id, password, will_topic, will_payload, ncmd_topic=None, state_topic=None):
    """
    Connect AS the target gateway: its `sparkplug_id` is the username. Returns at the TCP handshake;
    the CONNACK arrives later on paho's thread and is recorded on `client.aber`, never raised there.
    """
    client = mqtt.Client(client_id="aber-playback-%s" % edge_node_id)
    client.username_pw_set(edge_node_id, password)
    # The session's NDEATH as the Will, QoS 1 and not retained, so a worker that dies mid-replay is
    # announced too (tck-id-payloads-ndeath-will-message, -will-message-qos, -will-message-retain).
    client.will_set(will_topic, will_payload, qos=1, retain=False)
    client.aber = _SessionState(ncmd_topic, state_topic)
    client.on_connect = client.aber.on_connect
    client.on_disconnect = client.aber.on_disconnect
    client.on_subscribe = client.aber.on_subscribe
    client.on_message = client.aber.on_message
    if os.getenv("MQTT_TLS_ENABLED", "").strip().lower() in ("1", "true", "yes", "on"):
        import ssl
        ca = os.getenv("MQTT_TLS_CA_FILE", "").strip()
        client.tls_set(ca_certs=ca or None, cert_reqs=ssl.CERT_REQUIRED,
                       tls_version=ssl.PROTOCOL_TLS_CLIENT)
    client.connect(MQTT_HOST, MQTT_PORT, 60)
    return client


def _close_unborn(client):
    """End a session that published no NBIRTH: a plain DISCONNECT, so the broker discards the Will."""
    client.loop_stop()
    try:
        client.disconnect()
    except Exception:
        pass


def _await(condition, seconds, tick=None):
    """Poll `condition` until true or `seconds` pass, calling `tick` between polls. Returns it."""
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)
        if tick is not None:
            tick()
    return True


# The CONNACK return codes that mean the password, under MQTT 3.1.1 which this worker speaks: 4 bad
# user name or password, 5 not authorised. Only these move on to the next password a worker holds.
BAD_CREDENTIALS = (4, 5)


def _connect_accepted(edge_node, password, will_topic, bdseq, ncmd_topic, state_topic):
    """CONNECT with the NDEATH for `bdseq` as the Will and wait for the CONNACK.
    Returns (client, None, 0), or (None, error, CONNACK rc or None)."""
    try:
        client = _connect(edge_node, password, will_topic,
                          capture.node_death(bdseq, int(time.time() * 1000)),
                          ncmd_topic=ncmd_topic, state_topic=state_topic)
    except Exception as err:
        return None, "could not connect to the broker as %s: %s" % (edge_node, err), None

    # The CONNECT carrying this bdSeq was sent, whatever the broker answers.
    _next_bdseq[edge_node] = (bdseq + 1) % 256
    client.loop_start()

    # Nothing counts as sent until the broker accepts the CONNECT: a wrong password connects at the
    # socket and is refused afterwards.
    if not _await(lambda: client.aber.connack, CONNACK_TIMEOUT_SECONDS):
        client.loop_stop()
        return None, (
            "the broker never answered the connection as %s within %ss. It is reachable at %s:%s "
            "or this would have failed above, so it accepted the socket and said nothing."
            % (edge_node, CONNACK_TIMEOUT_SECONDS, MQTT_HOST, MQTT_PORT)
        ), None
    rc = client.aber.connack[0]
    if rc != 0:
        client.loop_stop()
        return None, _refused(edge_node, rc), rc
    client.aber.bdseq = bdseq
    return client, None, 0


def _open_session(edge_node, password, will_topic, bdseq, *, primary_host_id=None, tick=None,
                  source=None, fallbacks=(), confirm_subscription=False):
    """
    One Sparkplug session as the target gateway, ready for its NBIRTH. Returns (client, None), or
    (None, the reason the job fails).

    CONNECT with the NDEATH for `bdseq` as its Will, and wait for the CONNACK. A CONNACK refusing
    the password moves on to the next of `fallbacks`, [(source, password), ...], with the next
    bdSeq; `client.aber` records the bdSeq and the source accepted. Subscribe at QoS 1 to the node's
    own NCMD topic (tck-id-message-flow-edge-node-ncmd-subscribe) and, when a primary host is
    configured, to its STATE topic; with `confirm_subscription`, wait for the SUBACK and fail on a
    refusal. Then wait for that host to say it is online (tck-id-message-flow-edge-node-birth-
    publish-phid-wait, -online). The broker handles the SUBSCRIBE before the NBIRTH that follows it
    either way; a one-shot caller such as `capture.py play` need not wait.

    `primary_host_id` None means the PRIMARY_HOST_ID environment variable; "" means no wait. `tick`
    is called while waiting and may raise to abandon the session, which is then closed.
    """
    host = PRIMARY_HOST_ID if primary_host_id is None else primary_host_id
    group = will_topic.split("/")[1]
    ncmd_topic = "spBv1.0/%s/NCMD/%s" % (group, edge_node)
    state_topic = "spBv1.0/STATE/%s" % host if host else None

    attempts = [(source, password)] + list(fallbacks)
    refused = []
    for index, (label, secret) in enumerate(attempts):
        client, error, rc = _connect_accepted(edge_node, secret, will_topic, bdseq,
                                              ncmd_topic, state_topic)
        if client is not None:
            client.aber.source = label
            if refused:
                logger.warning("The broker accepted %s for %s after refusing %s.",
                               SOURCE_NAMES.get(label, "the next password"), edge_node,
                               " and ".join(refused))
            break
        if rc not in BAD_CREDENTIALS or index + 1 == len(attempts):
            if refused:
                error += " Also refused: %s." % " and ".join(refused)
            return None, error
        refused.append("%s (CONNACK rc=%s)" % (SOURCE_NAMES.get(label, "a password"), rc))
        bdseq = _next_bdseq[edge_node]

    try:
        topics = [(ncmd_topic, 1)] + ([(state_topic, 1)] if state_topic else [])
        result, mid = client.subscribe(topics)
        names = " and ".join(t for t, _ in topics)
        if result != mqtt.MQTT_ERR_SUCCESS or (confirm_subscription and not _await(
                lambda: mid in client.aber.subacks, CONNACK_TIMEOUT_SECONDS)):
            _close_unborn(client)
            return None, ("the broker did not acknowledge this worker's subscription to %s within "
                          "%ss" % (names, CONNACK_TIMEOUT_SECONDS))
        if any(granted >= 0x80 for granted in client.aber.subacks.get(mid, ())):
            _close_unborn(client)
            return None, ("the broker refused this worker's subscription to %s as %s, so it could "
                          "not hear a rebirth request or the primary host. The gateway role grants "
                          "both; check the broker's roles." % (names, edge_node))

        if host:
            def host_online():
                if client.aber.host_online is not True:
                    return False
                # Seen online: an offline from before this point no longer ends the session.
                client.aber.host_left.clear()
                return client.aber.host_online is True

            if not _await(host_online, PRIMARY_HOST_WAIT_SECONDS, tick):
                _close_unborn(client)
                return None, (
                    "the primary host '%s' did not say it is online on %s within %.0fs, so the "
                    "ingestion daemon is not consuming and nothing replayed now would reach the "
                    "historian. Start the playback again once ingestion is running."
                    % (host, state_topic, PRIMARY_HOST_WAIT_SECONDS)
                )
    except BaseException:
        _close_unborn(client)
        raise
    return client, None


def _refused(edge_node, rc):
    """The job's error for a CONNACK that refused the connection."""
    detail = {
        4: "the broker rejected the username or password",
        5: "the broker refused this connection as not authorised",
    }.get(rc, "the broker refused the connection")
    return (
        "%s for %s (CONNACK rc=%s), so the password this worker holds is not the one the "
        "broker has. A credential issued for this gateway reaches the worker within about a "
        "minute: if one was just issued, start the playback again then; otherwise issue a new "
        "one from the gateway's drawer on the Gateways page (Generate Broker Credential)."
        % (detail, edge_node, rc)
    )


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


def _host_went_offline(host, sent):
    """The job's error when the primary host's STATE says offline mid-replay."""
    return (
        "the primary host '%s' went offline after %d message(s), so the ingestion daemon stopped "
        "consuming. The NDEATH was published and the playback stopped; start it again once "
        "ingestion is back." % (host, sent)
    )


class _Session:
    """
    One open session: its client, the births published in it, and its own `seq` once a rebirth
    has been answered (from then on every message is re-stamped, NBIRTH restarting at 0).
    """

    def __init__(self, client, host):
        self.client = client
        self.host = host
        self.node_birth = None
        self.device_births = {}
        self.seq = None

    def publish(self, topic, raw, progress):
        _, msg_type, _, device = capture.split_topic(topic)
        out = raw
        if self.seq is not None:
            if msg_type == "NBIRTH":
                self.seq = 0
            out = _with_seq(raw, self.seq)
            self.seq = (self.seq + 1) % 256
        # QoS 0, as the fleet publishes: only paho's acceptance is observable, so a message counts
        # once paho has accepted it on a connection that has not dropped.
        info = self.client.publish(topic, out, qos=0, retain=False)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            raise _JobFailed(_connection_lost(progress.sent))
        if msg_type == "NBIRTH":
            self.node_birth = (topic, raw)
            self.device_births.clear()
        elif msg_type == "DBIRTH":
            self.device_births.pop(device, None)
            self.device_births[device] = (topic, raw)
        elif msg_type == "DDEATH":
            self.device_births.pop(device, None)

    def answer_rebirth(self, job_id, progress):
        """
        Re-publish this session's NBIRTH and the DBIRTHs of the devices born in it, seq 0 upward,
        before any further data (tck-id-operational-behavior-data-commands-rebirth-action-1, -2).
        The NBIRTH keeps the session's bdSeq (-rebirth-action-3).
        """
        self.client.aber.rebirth.clear()
        if self.node_birth is None:
            logger.info("Playback %s: a rebirth request arrived before this session's NBIRTH, "
                        "which answers it.", job_id)
            return
        births = [self.node_birth] + list(self.device_births.values())
        for seq, (topic, raw) in enumerate(births):
            info = self.client.publish(topic, _with_seq(raw, seq % 256), qos=0, retain=False)
            if info.rc != mqtt.MQTT_ERR_SUCCESS:
                raise _JobFailed(_connection_lost(progress.sent))
        self.seq = len(births) % 256
        logger.info("Playback %s: answered a rebirth request with the NBIRTH and %d DBIRTH(s), "
                    "after %d message(s).", job_id, len(births) - 1, progress.sent)

    def check(self, job_id, progress):
        """Between messages: a dropped connection or an offline primary host ends the job, and a
        rebirth request is answered."""
        aber = self.client.aber
        if aber.lost.is_set():
            raise _JobFailed(_connection_lost(progress.sent))
        if aber.host_left.is_set():
            # tck-id-message-flow-edge-node-birth-publish-phid-offline: the NDEATH, then DISCONNECT,
            # which the caller's _end_session() does.
            raise _JobFailed(_host_went_offline(self.host, progress.sent))
        if aber.rebirth.is_set():
            self.answer_rebirth(job_id, progress)


def _wait_until(target, progress, session, job_id=None):
    """
    Sleep until `target` (time.monotonic()) in slices of at most SLEEP_SLICE_SECONDS, checking the
    session and reporting progress after each, so Stop, a lost connection, an offline primary host
    and a rebirth request are all dealt with within a slice.
    """
    while True:
        remaining = target - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(SLEEP_SLICE_SECONDS, remaining))
        if session is not None:
            session.check(job_id, progress)
        progress.report(force=True)


def _run_job(supabase, storage, credentials, job, outcome=None):
    """
    Publish one capture. Returns (messages_sent, messages_out_of_window, error or None).

    `credentials` maps a gateway to its password, or to [(source, password), ...] in the order to
    try them. `outcome` gets "stopped" when the operator stopped the job, and "accepted", the
    (source, password) the broker accepted.
    """
    edge_node = job["target_edge_node_id"]
    held = credentials.get(edge_node)
    candidates = [(None, held)] if isinstance(held, str) else list(held or [])
    outcome = {} if outcome is None else outcome

    if not candidates:
        # Refused before connecting: a connect with no password fails naming neither the gateway
        # nor the missing secret.
        return 0, 0, (
            "this worker holds no broker credential for %s, so it cannot authenticate as that "
            "gateway. Issue one from the gateway's drawer on the Gateways page (Generate Broker "
            "Credential): it reaches this worker within about a minute, with no restart." % edge_node
        )

    # ------------------------------------------------------------------------------------------
    # The capture, downloaded to a file of its own and read from it a message at a time, so
    # memory does not grow with its size. The file is deleted when it is closed.
    # ------------------------------------------------------------------------------------------
    with tempfile.TemporaryFile() as spool:
        try:
            storage.download_to(job["capture_storage_path"], spool)
        except Exception as err:
            # 42501 here is the read gate: the bucket's SELECT policy admits `Service_Playback`
            # only to the object of a RUNNING job. If this fails on a job that IS running, the
            # policy arm is missing rather than the file.
            return 0, 0, "could not read %s: %s" % (job["capture_storage_path"], err)
        return _replay(supabase, _chunks_of(spool), job, candidates, outcome)


def _chunks_of(spool):
    """The spooled capture as capture.FilePlan reads it: from its start, in chunks, per call."""
    def chunks():
        spool.seek(0)
        return iter(lambda: spool.read(DOWNLOAD_CHUNK_BYTES), b"")
    return chunks


def _replay(supabase, open_chunks, job, candidates, outcome):
    """_run_job() once the capture is in hand: plan it, judge it, and publish it."""
    job_id = job["id"]
    edge_node = job["target_edge_node_id"]

    # ------------------------------------------------------------------------------------------
    # The plan
    # ------------------------------------------------------------------------------------------
    # Everything that can be wrong is decided here, with no broker; the loop below decides nothing.
    # Planned with the bdSeq the next CONNECT carries, which a refused password may move on.
    play_epoch_ms = int(time.time() * 1000)
    speed = float(job.get("speed") or 1.0)
    device_map = job.get("device_map") or {}
    bdseq = _next_bdseq.get(edge_node, 0)

    try:
        plan = capture.FilePlan(open_chunks, edge_node, device_map, play_epoch_ms, speed=speed,
                                group=job.get("sparkplug_group"), bdseq=bdseq)
    except capture.CaptureError as err:
        return 0, 0, str(err)
    except ValueError as err:
        return 0, 0, "%s is not valid JSON: %s" % (job["capture_storage_path"], err)

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
    # on `plan.lossy >= len(plan)` would report that one as having written nothing.
    #
    # `capture.py play` refuses BOTH cases unless --allow-unsane is passed, and that difference is
    # deliberate rather than an oversight: the CLI has an escape hatch to pass and a person at a
    # terminal to read the message, and the page has neither.
    out_of_window = plan.lossy
    if plan.metrics_dropped and not plan.metrics_kept:
        topic, ts, at = plan.first_lossy
        return 0, out_of_window, (
            "every one of the %d reading(s) in this capture carries a timestamp the ingestion "
            "daemon will discard as too old or too far in the future, so this playback would "
            "publish the whole capture and write nothing to the historian (first: %s, stamped %s, "
            "would be sent at %s). %s" % (
                plan.metrics_dropped, topic,
                datetime.fromtimestamp(ts / 1000.0, timezone.utc).isoformat(),
                datetime.fromtimestamp(at / 1000.0, timezone.utc).isoformat(),
                capture.window_explanation(speed),
            )
        )
    if out_of_window:
        logger.warning(
            "Playback %s: %d of %d message(s) carry timestamps the daemon will drop as too old or "
            "too far in the future. They will be published and silently discarded on ingest.",
            job_id, out_of_window, len(plan),
        )

    # ------------------------------------------------------------------------------------------
    # Publishing
    # ------------------------------------------------------------------------------------------
    # Every planned topic is under the job's group, so the first names the edge node's.
    will_topic = "spBv1.0/%s/NDEATH/%s" % (capture.split_topic(plan.first_topic)[0], edge_node)
    host = PRIMARY_HOST_ID
    progress = _Progress(supabase, job_id, len(plan))
    session = None
    error = None

    def open_session():
        # The first session may fall back to a later password; the rest use the one accepted.
        source, password = outcome.get("accepted") or candidates[0]
        fallbacks = () if "accepted" in outcome else candidates[1:]
        client, failure = _open_session(edge_node, password, will_topic, bdseq,
                                        primary_host_id=host, tick=progress.report,
                                        source=source, fallbacks=fallbacks,
                                        confirm_subscription=True)
        if failure:
            raise _JobFailed(failure if not progress.sent else
                             "publishing stopped after %d message(s): %s" % (progress.sent, failure))
        if "accepted" not in outcome:
            outcome["accepted"] = next(c for c in candidates if c[0] == client.aber.source)
            if source is not None:
                logger.info("Playback %s: connected as %s with %s.", job_id, edge_node,
                            SOURCE_NAMES.get(client.aber.source, "its password"))
        return _Session(client, host)

    try:
        session = open_session()
        if session.client.aber.bdseq != bdseq:
            # A refused password spent a bdSeq: the plan carries the one the broker accepted.
            bdseq = session.client.aber.bdseq
            plan.bdseq = bdseq
        progress.started = time.monotonic()
        for delay_ms, topic, payload_bytes, _ in plan:
            # An absolute schedule: per-message sleeps would drift by every publish and progress
            # call, and the rebased timestamps would drift out of window with them.
            _wait_until(progress.started + delay_ms / 1000.0, progress, session, job_id)

            if session is None:
                session = open_session()
            session.check(job_id, progress)

            if capture.split_topic(topic)[1] == "NDEATH":
                # A recorded death ends the session as it ended the recorded node's. The plan
                # numbered the messages after it as the next session, which opens on the next one.
                _end_session(session.client, topic, payload_bytes)
                session = None
                bdseq = (bdseq + 1) % 256
            else:
                session.publish(topic, payload_bytes, progress)
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
        if session is not None:
            _end_session(session.client, will_topic,
                         capture.node_death(bdseq, int(time.time() * 1000)))

    return progress.sent, out_of_window, error




class _Holdings:
    """
    The broker passwords this worker holds, and the heartbeat that reports them.

    The main loop re-reads the sources every pass (refresh()); a timer thread reports what is held
    every CREDENTIAL_REPORT_INTERVAL_SECONDS and at once after a change, whether or not a job is
    running, so a long playback does not read as a worker that stopped. Ids and source names only,
    never passwords: `playback_worker_status` is readable by three roles.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._changed = threading.Event()
        self.sources = _credential_sources()
        # The (source, password) the broker last accepted for each gateway, tried first while held.
        self._accepted = {}
        # Gateways with a password picked up since the last report that got through. Everything
        # counts at startup: the sources were just read.
        self._rotated = set(self.sources)

    @property
    def credentials(self):
        """{gateway: password tried first}."""
        return {gateway: candidates[0][1] for gateway, candidates in self.for_jobs().items()}

    def for_jobs(self):
        """{gateway: [(source, password), ...]}, the one the broker last accepted first."""
        with self._lock:
            return self._ordered()

    def _ordered(self):
        ordered = {}
        for gateway, candidates in self.sources.items():
            accepted = self._accepted.get(gateway)
            ordered[gateway] = ([accepted] + [c for c in candidates if c != accepted]
                                if accepted in candidates else list(candidates))
        return ordered

    def accepted(self, gateway, choice):
        """Remember which (source, password) the broker accepted; a change is reported at once."""
        with self._lock:
            if self._accepted.get(gateway) == choice:
                return
            self._accepted[gateway] = choice
        logger.info("Playback credentials: %s is now used first for %s.",
                    SOURCE_NAMES.get(choice[0], "the password the broker accepted"), gateway)
        self._changed.set()

    def refresh(self):
        """Re-read the sources, log a change by gateway id, and wake the heartbeat for it."""
        current = _credential_sources()
        with self._lock:
            previous, self.sources = self.sources, current
            if current == previous:
                return self._ordered()
            gained = sorted(set(current) - set(previous))
            lost = sorted(set(previous) - set(current))
            # A re-issue keeps the id and changes a password, so the lists are compared.
            rotated = sorted(k for k in set(current) & set(previous) if current[k] != previous[k])
            self._rotated.update(gained)
            self._rotated.update(rotated)
            self._rotated.difference_update(lost)
            # A new password anywhere puts the delivered one first again.
            for gateway in rotated + lost:
                self._accepted.pop(gateway, None)
            ordered = self._ordered()
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
        return ordered

    def report(self, supabase):
        """One heartbeat. A rotation is cleared only once a report carrying it got through."""
        with self._lock:
            ordered = self._ordered()
            rotated = sorted(self._rotated)
        supabase.rpc("playback_report_credentials", {
            "p_edge_nodes": sorted(ordered),
            "p_rotated": rotated,
        }).execute()
        with self._lock:
            self._rotated.difference_update(rotated)
        supabase.rpc("playback_report_credential_sources", {
            "p_sources": {gateway: [source for source, _ in candidates]
                          for gateway, candidates in ordered.items()},
        }).execute()

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
            "of an identity to publish as. Issuing a broker credential for the Playback gateway "
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
        if outcome.get("accepted"):
            holdings.accepted(job["target_edge_node_id"], outcome["accepted"])

        if not _finish(supabase, job, sent, error, out_of_window):
            continue

        if error:
            logger.warning("Playback %s failed after %d message(s): %s", job["id"], sent, error)
        elif outcome.get("stopped"):
            logger.info("Playback %s stopped by the operator: %d message(s) published as %s.",
                        job["id"], sent, job["target_edge_node_id"])
        else:
            logger.info("Playback %s complete: %d message(s) published as %s.",
                        job["id"], sent, job["target_edge_node_id"])


if __name__ == "__main__":
    main()
