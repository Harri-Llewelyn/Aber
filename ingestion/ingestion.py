import logging
import os
import queue
import re
import signal
import ssl
import threading
import time
from collections import OrderedDict
from typing import NamedTuple
import psycopg2
from psycopg2.extras import execute_values
import paho.mqtt.client as mqtt
import sparkplug_b_pb2
from datetime import datetime, timezone
from logging_config import get_logger
from metrics import start_metrics_server
import registry
from registry import (
    count, count_labelled, counter_snapshot, observe_uns_seconds, observe_write_seconds,
    WRITE_SECONDS_BUCKETS,
)
from conformance import (
    MetricConstraint, ModelledSchema, constraint_violations, enforceable_violation,
    modelled_constraints, payload_violations, violation_signature,
)
# capture.py owns the capture file format, so the daemon and the CLI cannot diverge.
import capture_worker
# Imported at module level so a syntax error in it is a startup failure.
import directory_publish
import primary_host
import uns_publish

logger = get_logger("ingestion")

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
TIMESCALEDB_URL = os.getenv("TIMESCALEDB_URL")
DB_HOST = os.getenv("DB_HOST", "timescaledb")
DB_PORT = os.getenv("DB_PORT", "5433" if os.getenv("DB_HOST") is None else "5432")
DB_NAME = os.getenv("DB_NAME", "postgres")
DB_USER = os.getenv("DB_USER", "postgres")
# No default: a missing password must refuse to start (validated in main(), not at import, so
# the unit suites can import this module with a stubbed environment).
DB_PASSWORD = os.getenv("DB_PASSWORD")

# MQTT Broker configuration
MQTT_HOST = os.getenv("MQTT_HOST", "mosquitto")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
# The INGESTION principal, not a shared platform account. The broker's roles grant it `read
# spBv1.0/#` plus `write spBv1.0/+/NCMD/+` and nothing else, which is exactly what this daemon
# does: it is a consumer whose only publish() is the rebirth NCMD in request_rebirth().
MQTT_USER = os.getenv("MQTT_USER", "factoryplus_ingestion")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD")

# MQTTS is opt-in and does not change how the daemon authenticates. Verification is always on;
# there is no "skip verification" setting. See ingestion/README.md -> "MQTTS (opt-in)".
MQTT_TLS_ENABLED = os.getenv("MQTT_TLS_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")
MQTT_TLS_CA_FILE = os.getenv("MQTT_TLS_CA_FILE", "").strip()

# Supabase configuration
SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")

# Two keys with different jobs (see Machine Identities in supabase/README.md): the publishable
# key is the `apikey` the gateway's filter admits; the ingestion token is the bearer that names
# Service_Ingestor, whose writes all go through SECURITY DEFINER gates.
SUPABASE_GATEWAY_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
SUPABASE_INGESTION_KEY = os.getenv("SUPABASE_INGESTION_KEY", "")

# Liveness heartbeat, opt-in: the chart sets the file and probes its
# age. Written on a timer gated on client.is_connected(), not per message, so a quiet shopfloor
# does not read as a dead daemon.
INGESTION_HEALTH_FILE = os.getenv("INGESTION_HEALTH_FILE", "")
INGESTION_HEALTH_INTERVAL = int(os.getenv("INGESTION_HEALTH_INTERVAL", "15"))

# Device liveness watchdog. A device that stops publishing writes nothing and emits no DDEATH, so
# without this it stays ONLINE forever. Set to 0 to disable -- see ingestion/README.md for when an
# event-driven device needs the window raised instead.
DEVICE_OFFLINE_TIMEOUT_SECONDS = int(os.getenv("DEVICE_OFFLINE_TIMEOUT_SECONDS", "300"))
DEVICE_WATCHDOG_INTERVAL_SECONDS = int(os.getenv("DEVICE_WATCHDOG_INTERVAL_SECONDS", "30"))

# Rebirth requests are rate limited per edge node. A gateway that answers a rebirth by restarting
# would otherwise be held in a reboot loop by the very mechanism meant to recover it.
REBIRTH_REQUEST_INTERVAL_SECONDS = int(os.getenv("REBIRTH_REQUEST_INTERVAL_SECONDS", "300"))

# Bound on the per-node alias table. It is fed by whatever the broker delivers, so a gateway
# looping births with fresh aliases would otherwise grow it without limit.
MAX_ALIASES_PER_NODE = int(os.getenv("MAX_ALIASES_PER_NODE", "5000"))

# Capacity bound on each entity cache. The keys are ids seen on the wire, so a TTL alone is not a
# bound: expiry is only checked on read. 1000 is above any plausible fleet.
MAX_ENTITIES_PER_CACHE = int(os.getenv("MAX_ENTITIES_PER_CACHE", "1000"))

# Negative entries share the TTL. The write sites in process_dbirth() set or pop the entry, so a
# newly registered device does not wait for expiry; a shorter negative TTL would only add directory
# round trips during an id flood.

# Throughput counter reporting. Set to 0 to disable. Separate from the health heartbeat, which
# returns immediately when INGESTION_HEALTH_FILE is unset; this is what `docker logs` shows.
INGESTION_STATS_INTERVAL = int(os.getenv("INGESTION_STATS_INTERVAL", "60"))

# Prometheus exposition endpoint; 0 disables it. Its own port because the daemon listens for
# nothing else. No credential, so counters only: no values, names or payloads (see metrics.py).
INGESTION_METRICS_PORT = int(os.getenv("INGESTION_METRICS_PORT", "9108"))

# Maximum tuples per INSERT statement; execute_values pages a larger batch.
TELEMETRY_INSERT_PAGE_SIZE = int(os.getenv("TELEMETRY_INSERT_PAGE_SIZE", "500"))

# The historian writer (see TelemetryWriter). Messages waiting to be written are bounded so a
# stalled historian cannot grow the process without limit; a full queue holds the callback
# thread for the put timeout, which is backpressure onto the broker, then drops.
TELEMETRY_QUEUE_MAX_MESSAGES = int(os.getenv("TELEMETRY_QUEUE_MAX_MESSAGES", "10000"))
TELEMETRY_QUEUE_PUT_TIMEOUT_SECONDS = float(os.getenv("TELEMETRY_QUEUE_PUT_TIMEOUT_SECONDS", "5"))
# Messages per transaction, at most.
TELEMETRY_BATCH_MAX_MESSAGES = int(os.getenv("TELEMETRY_BATCH_MAX_MESSAGES", "500"))
# How long a SIGTERM waits for the queue to drain. Inside the pod's termination grace period.
TELEMETRY_SHUTDOWN_DRAIN_SECONDS = float(os.getenv("TELEMETRY_SHUTDOWN_DRAIN_SECONDS", "8"))

# Seconds between directory refresh passes (see refresh_directory_caches). 0 disables the thread
# and every cache miss costs a round trip, as it did before the thread existed.
DIRECTORY_REFRESH_SECONDS = float(os.getenv("DIRECTORY_REFRESH_SECONDS", "5"))

# Bounded retry on a failed TimescaleDB connection. It runs on the paho callback thread, which
# every device shares, so the ceiling is deliberately low.
DB_CONNECT_MAX_ATTEMPTS = int(os.getenv("DB_CONNECT_MAX_ATTEMPTS", "3"))
DB_CONNECT_BACKOFF_SECONDS = float(os.getenv("DB_CONNECT_BACKOFF_SECONDS", "0.25"))
DB_CONNECT_BACKOFF_MAX_SECONDS = float(os.getenv("DB_CONNECT_BACKOFF_MAX_SECONDS", "2.0"))

# Unbounded retry off the message path, for a historian that is not up yet (Docker restarts
# containers in its own order; depends_on does not apply). Nothing is lost while it waits.
DB_HEAL_INTERVAL_SECONDS = float(os.getenv("DB_HEAL_INTERVAL_SECONDS", "30"))
# Bounded so the healer's period is its own, rather than whatever the OS decides a dead TCP peer
# is worth. psycopg2's default is the kernel's, which can be minutes.
DB_HEAL_CONNECT_TIMEOUT_SECONDS = int(os.getenv("DB_HEAL_CONNECT_TIMEOUT_SECONDS", "10"))

# -----------------------------------------------------------------------------
# Payload conformance auditing
# -----------------------------------------------------------------------------
# On by default and switchable because it writes to an append-only table that no application
# role can prune.
AUDIT_PAYLOAD_REJECTIONS = os.getenv("AUDIT_PAYLOAD_REJECTIONS", "true").lower() == "true"

# Schema bindings change on a human timescale, so they are cached far longer than the device row
# (CACHE_TTL_SECONDS). Staleness cannot cause a wrong drop: see payload_violations().
SCHEMA_CACHE_TTL_SECONDS = int(os.getenv("SCHEMA_CACHE_TTL_SECONDS", "300"))

# -----------------------------------------------------------------------------
# Supabase Client Initialization
# -----------------------------------------------------------------------------
supabase_client = None
try:
    from supabase import create_client, Client
    if SUPABASE_URL and SUPABASE_GATEWAY_KEY and SUPABASE_INGESTION_KEY:
        # Names the daemon as the actor behind its writes; log_digital_thread_event() reads it from
        # the `request.headers` GUC and accepts only 'ingestion' / 'service' / 'migration'.
        # Set on the PostgREST session: ClientOptions(headers=...) raises in supabase-py 2.x.
        supabase_client = create_client(SUPABASE_URL, SUPABASE_GATEWAY_KEY)
        try:
            # `.auth()`, not a session header: supabase-py re-derives Authorization from the client's
            # token on every request, so a header set by hand is silently replaced by the gateway key.
            # The apikey stays the gateway key; the bearer is what resolves auth.uid() to Service_Ingestor.
            supabase_client.postgrest.auth(SUPABASE_INGESTION_KEY)
            supabase_client.postgrest.session.headers["X-Aber-Actor"] = "ingestion"
        except Exception as header_err:
            # Losing the label is not worth losing ingestion over: without it the trigger falls
            # back to 'service', which is still attributed, just less specific.
            logger.warning(
                "Could not set the actor header (%s); audit rows will read 'service'.", header_err
            )
        logger.info("Supabase client initialized successfully.")
    else:
        logger.warning(
            "SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY or SUPABASE_INGESTION_KEY missing. Supabase "
            "integration disabled. SUPABASE_INGESTION_KEY replaced SUPABASE_SERVICE_ROLE_KEY -- "
            "see Machine Identities in supabase/README.md; the chart sets it from secrets.ingestionKey."
        )
except Exception as e:
    logger.warning("Failed to initialize Supabase client: %s", e)

# -----------------------------------------------------------------------------
# TimescaleDB Connection Manager
# -----------------------------------------------------------------------------
_ts_conn = None

# Guards assignment of `_ts_conn` between the callback thread and the healer thread. It is still
# one writer: the healer opens connections and never uses them (psycopg2 threadsafety 2 allows the
# hand-off). The healer never holds this across a connect attempt.
_ts_conn_lock = threading.RLock()

def _open_timescaledb_connection():
    """One connection attempt. Split out so the retry loop below stays readable."""
    if TIMESCALEDB_URL:
        return psycopg2.connect(TIMESCALEDB_URL)
    return psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        database=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD
    )

# The escape hatch for the check below. Deliberately a separate variable from INGEST_DB_USER: the
# credential and the permission to use a dangerous one are different decisions, and requiring both
# means nobody reaches this state by editing one line.
ALLOW_HISTORIAN_SUPERUSER = os.getenv(
    "ALLOW_HISTORIAN_SUPERUSER", ""
).strip().lower() in ("1", "true", "yes", "on")

def _is_authentication_failure(err):
    """
    True for a credential the server actively refused, as opposed to one it never saw.

    SQLSTATE first (28P01 invalid_password, 28000 invalid_authorization_specification); the text
    match is a narrow fallback for a driver-level failure with no code. A refused connection or
    DNS failure must not match: those are transient.
    """
    code = getattr(err, "pgcode", None)
    if code in ("28P01", "28000"):
        return True
    text = str(err).lower()
    return "password authentication failed" in text or "no password supplied" in text

def _connect_timescaledb(connect_timeout=None):
    """
    One connection attempt, with the exception left to the caller.

    `connect_timeout` is for the healer; absent, libpq's default applies. A keyword alongside a
    DSN is supported, with the keyword winning.
    """
    kwargs = {} if connect_timeout is None else {"connect_timeout": connect_timeout}
    if TIMESCALEDB_URL:
        return psycopg2.connect(TIMESCALEDB_URL, **kwargs)
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD, **kwargs
    )

def _assert_historian_is_least_privilege(conn):
    """
    Refuse to run as a superuser on the historian.

    The security model claims append-only historian writes; asking the database what this
    connection is enforces that regardless of configuration. Refuses rather than warns.
    ALLOW_HISTORIAN_SUPERUSER=true is the deliberate override. Only superuser is tested; the
    grant list is asserted by timescaledb/roles.sql and test_historian_role_grants.py.
    """
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT current_user, usesuper FROM pg_user WHERE usename = current_user")
            row = cur.fetchone()
    except Exception as err:
        # Not fatal. An unreadable catalog is a database problem, and refusing to ingest over a
        # failed self-check would turn a diagnostic into an outage.
        logger.warning("Could not determine the historian role's privileges: %s", err)
        return

    if not row:
        logger.warning("Could not determine the historian role's privileges: no pg_user row.")
        return

    user, is_super = row[0], bool(row[1])
    if not is_super:
        logger.info(
            "Historian credential: connected as '%s', which is not a superuser. Telemetry writes "
            "are append-only by grant.", user
        )
        return

    if ALLOW_HISTORIAN_SUPERUSER:
        logger.warning(
            "HISTORIAN SUPERUSER IN USE: connected as '%s', which can UPDATE, DELETE and DROP the "
            "telemetry hypertable. ALLOW_HISTORIAN_SUPERUSER is set, so this is permitted -- but "
            "the security model's 'append-only historian writes' is not being enforced by the "
            "database while it is.", user
        )
        return

    logger.critical(
        "CRITICAL CONFIGURATION ERROR: connected to the historian as '%s', which is a SUPERUSER. "
        "This process is the most exposed to the plant network, and that credential can DROP the "
        "telemetry hypertable and rewrite any observation -- so 'append-only historian writes' in "
        "the security model would be a claim nothing enforces. Set INGEST_DB_USER=ingest_writer "
        "with INGEST_WRITER_PASSWORD (npm run setup mints one; timescaledb/roles.sql creates the "
        "role). If admin rights are genuinely needed for a recovery, set "
        "ALLOW_HISTORIAN_SUPERUSER=true and say so out loud.", user
    )
    raise SystemExit(1)

def get_timescaledb_connection():
    """
    The daemon's single TimescaleDB connection, reconnecting when it has gone away.

    One connection, one writer (the paho callback thread). `closed` only reflects a close on this
    side; a server-side drop fails on first use and the caller's handler covers it. Retries are
    bounded because this thread is shared by the whole fleet. The lock serialises assignment
    against the healer thread only. See ingestion/README.md -> "Connection handling".
    """
    global _ts_conn

    with _ts_conn_lock:
        if _ts_conn is not None and _ts_conn.closed == 0:
            return _ts_conn

        if _ts_conn is not None:
            # Closed on this side. Say so rather than reconnecting silently -- a connection that
            # keeps having to be re-opened is a symptom worth seeing in the log.
            logger.info("TimescaleDB connection was closed; re-opening.")
            count("db_reconnects")
            _ts_conn = None

        delay = DB_CONNECT_BACKOFF_SECONDS
        for attempt in range(1, DB_CONNECT_MAX_ATTEMPTS + 1):
            try:
                _ts_conn = _open_timescaledb_connection()
                if attempt > 1:
                    logger.info("Connected to TimescaleDB on attempt %d.", attempt)
                else:
                    logger.info("Connected to TimescaleDB successfully.")
                return _ts_conn
            except Exception as e:
                count("db_connect_failures")
                if attempt == DB_CONNECT_MAX_ATTEMPTS:
                    # Final failure. The caller drops the message; the counter is what makes that
                    # loss visible without reading the log.
                    logger.warning(
                        "TimescaleDB connection failed after %d attempt(s): %s. Telemetry for "
                        "this message is dropped; the next message retries.",
                        DB_CONNECT_MAX_ATTEMPTS, e
                    )
                    _ts_conn = None
                    return None

                logger.warning(
                    "TimescaleDB connection attempt %d/%d failed: %s. Retrying in %.2fs.",
                    attempt, DB_CONNECT_MAX_ATTEMPTS, e, delay
                )
                time.sleep(delay)
                delay = min(delay * 2, DB_CONNECT_BACKOFF_MAX_SECONDS)

    return None

# -----------------------------------------------------------------------------
# Sparkplug B Wire Identity
# -----------------------------------------------------------------------------
# Assets are addressed on the wire by the platform-issued `sparkplug_id` (3-char prefix plus 21
# hex chars, derived from the row's UUID). Names are display labels only.
GATEWAY_ID_PATTERN = re.compile(r"^gwy[0-9a-f]{21}$")
DEVICE_ID_PATTERN = re.compile(r"^dev[0-9a-f]{21}$")
SPARKPLUG_ID_LENGTH = 24

# An RFC4122 UUID as Factory+ publishes one in `Instance_UUID`. Matched case-insensitively
# because the standard does not fix the case and PostgREST compares uuid values, not text.
UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Metrics that carry identity rather than configuration or telemetry. None is stored as a
# parameter, a sample or a declared metric: a schema models measurements, not identity.
IDENTITY_METRICS = ("Asset_ID", "Asset_Name", "Instance_UUID", "Schema_UUID")

# The Factory+ Sparkplug payload marker, carried in the payload's top-level `uuid` field. Read
# for logging only: the topic is still what identifies the asset.
FACTORYPLUS_PAYLOAD_UUID = "11ad7b32-1d32-4c4a-b0c9-fa049208939a"

# The site's Sparkplug Group ID, named by the chart and held by `sparkplug.group_id` (0131), which
# is also what gateways.sparkplug_group defaults to. Used only to describe the fallback in a log
# line; resolution never assumes it -- a gateway is resolved on the (group, node) pair its own row
# carries.
DEFAULT_SPARKPLUG_GROUP = os.getenv("SPARKPLUG_GROUP", "Aber")

class DirectoryUnavailable(Exception):
    """
    The device/gateway directory could not be reached. Distinct from "not registered".

    process_dbirth() answers "unregistered" by writing a quarantine row, which persists until an
    operator approves the device. A transport fault must not do that, so callers drop the message
    and the next one resolves normally.
    """

# Recorded on devices.quarantine_reason as "<CODE>: <detail>".
REASON_UNKNOWN_DEVICE = "UNKNOWN_DEVICE"
REASON_MALFORMED_IDENTITY = "MALFORMED_IDENTITY"
REASON_IDENTITY_MISMATCH = "IDENTITY_MISMATCH"
REASON_GATEWAY_MISMATCH = "GATEWAY_MISMATCH"

# Telemetry sanity window. Device timestamps are trusted for ordering but not unconditionally.
# Asymmetric: late data is normal (a gateway flushing after an outage); future data is always
# a clock fault, so the forward tolerance covers NTP skew only.
TELEMETRY_MAX_AGE_SECONDS = 24 * 60 * 60   # 24 hours behind now
TELEMETRY_MAX_FUTURE_SECONDS = 5 * 60      # 5 minutes ahead of now

# Recorded on devices.identity_source.
SOURCE_SPARKPLUG_ID = "sparkplug_id"
SOURCE_REPORTED_IDENTITY = "reported_identity"
SOURCE_INSTANCE_UUID = "instance_uuid"
SOURCE_LEGACY_NAME = "legacy_name"

# Statuses a gateway may not assert about itself. PENDING_ENROLLMENT and AWAITING_BIRTH are
# enrolment lifecycle; STALE is derived at read time by public.gateway_status. All three
# short-circuit the staleness arm, so a gateway claiming one would never read STALE.
# Rejected with a warning, not truncated or remapped.
RESERVED_GATEWAY_STATUSES = frozenset({"PENDING_ENROLLMENT", "AWAITING_BIRTH", "STALE"})

# Over-length is refused rather than truncated: a truncated status is a different status.
MAX_GATEWAY_STATUS_LENGTH = 32

CACHE_TTL_SECONDS = 5

class TTLCache:
    """
    A bounded, TTL'd, thread-safe LRU.

    Two properties callers depend on:

    1. `get` returns the stored object, never a copy. The DBIRTH path mutates the cached row in
       place so the next lookup inside the TTL sees the new state and does not re-detect it.
    2. `get` returns `(hit, value)`. None is a legitimate cached value (a negative entry), so a
       default-returning get would conflate absent and cached-as-unregistered.

    Eviction is LRU: the entry a TTL cannot reach is the one nobody has read.
    """

    def __init__(self, maxsize, ttl, name):
        self._data = OrderedDict()
        self._lock = threading.Lock()
        self.maxsize = maxsize
        self.ttl = ttl
        self.name = name
        # Not a counter() call: this module's registry is imported by tests that never start a
        # daemon, and a cache should not need one to be constructible.
        self.evictions = 0

    def get(self, key):
        """`(True, value)` on a live hit; `(False, None)` when absent or expired."""
        with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return False, None
            value, cached_at = entry
            if time.time() - cached_at >= self.ttl:
                # Dropped rather than left to age further: it can never be a hit again, and
                # holding it would spend a capacity slot on a known-dead key.
                del self._data[key]
                return False, None
            self._data.move_to_end(key)
            return True, value

    def set(self, key, value):
        with self._lock:
            if key in self._data:
                # Refreshing an existing key cannot grow the cache, so no eviction is needed --
                # the same distinction register_aliases() draws against MAX_ALIASES_PER_NODE.
                self._data[key] = (value, time.time())
                self._data.move_to_end(key)
                return
            while len(self._data) >= self.maxsize:
                self._data.popitem(last=False)
                self.evictions += 1
            self._data[key] = (value, time.time())

    def pop(self, key, default=None):
        with self._lock:
            entry = self._data.pop(key, None)
            return default if entry is None else entry[0]

    def clear(self):
        with self._lock:
            self._data.clear()

    def __len__(self):
        with self._lock:
            return len(self._data)

    def __contains__(self, key):
        hit, _ = self.get(key)
        return hit

# Device and edge-node resolution caches, keyed by the id seen on the wire (the gateway one by the
# (group, node) PAIR -- see resolve_gateway). Values are the row, or None for a negative entry.
_device_cache = TTLCache(MAX_ENTITIES_PER_CACHE, CACHE_TTL_SECONDS, "device")
_gateway_cache = TTLCache(MAX_ENTITIES_PER_CACHE, CACHE_TTL_SECONDS, "gateway")

# Sparkplug B node-level (edge gateway) message types, as opposed to the device-level
# DBIRTH/DDATA/DDEATH. Their topics carry no device component.
NODE_MESSAGE_TYPES = ("NBIRTH", "NDATA", "NDEATH")

# Throttle for "unregistered edge node" warnings, keyed by edge node id.
_unknown_gateway_warned = {}
UNKNOWN_GATEWAY_WARN_INTERVAL_SECONDS = 300

# Throttle for legacy name-based identity deprecation warnings, keyed by the id on the wire.
_legacy_identity_warned = {}
LEGACY_IDENTITY_WARN_INTERVAL_SECONDS = 300

# Throttle for refused self-reported gateway statuses, keyed by edge node id. A node that reports
# one reports it on every heartbeat -- 119 an hour -- so the refusal has to be legible without
# being the whole log.
_status_rejected_warned = {}
STATUS_REJECT_WARN_INTERVAL_SECONDS = 300

# Sparkplug B metric alias table, keyed by edge node: (group_id, edge_node_id) -> {alias: name}.
# Per node, not per device: alias uniqueness is scoped to the whole edge node, so a device's
# DDATA may carry an alias declared in the node's NBIRTH.
_alias_map = {}
_alias_lock = threading.Lock()

# Throttle for rebirth requests, keyed "<group>/<node>".
_rebirth_requested = {}
REBIRTH_METRIC_NAME = "Node Control/Rebirth"

# Last Sparkplug `seq` seen per edge node, keyed exactly like the alias table above -- the
# counter is per EDGE NODE and shared by its devices, so a device's DDATA advances the same run
# its gateway's NDATA does. See check_message_sequence().
_last_seq = {}
_seq_lock = threading.Lock()

# Devices heard from in THIS process -- {device_uuid: {"at": monotonic, "name": label}}.
# Deliberately in-memory and deliberately not seeded from the database: see stale_device_ids().
_device_seen = {}
_device_seen_lock = threading.Lock()

# `status` and `identity_source` are read back so process_dbirth() can skip an UPDATE that
# changes nothing. `devices` is REPLICA IDENTITY FULL and published to Realtime, so every
# no-op write would broadcast a full-row event; the audit trigger suppresses only the audit row.
# `is_archived` is fetched rather than filtered for the reason _GATEWAY_COLUMNS gives below:
# resolve_device() refuses an archived device, and an archived one must not read as absent.
_DEVICE_COLUMNS = (
    "id,name,sparkplug_id,reported_identity,gateway_id,is_quarantined,first_dbirth_at,"
    "last_birth_metrics,status,identity_source,conformance_policy,is_archived"
)

# `status` lets process_node_message() tell a transition from a repeated heartbeat in the log.
# `is_archived` is fetched rather than filtered so an archived gateway is distinguishable from
# an unregistered one; resolve_gateway() refuses it.
_GATEWAY_COLUMNS = "id,name,sparkplug_id,sparkplug_group,status,is_archived"

# The value of devices.conformance_policy that lets a violation DROP a metric rather than only
# record it (0050). Anything else -- including the 'audit' default and a row fetched before this
# column existed -- means record and write anyway, which is the behaviour since 0026.
CONFORMANCE_ENFORCE = "enforce"

# The drop pair. `reason` produces both the flat counter `dropped_<reason>` and the `reason`
# field on the warning. Per-device fields go on the log line and never on the counter: the
# metrics endpoint is unauthenticated and its label cardinality is bounded (metrics.py).
# `emit_log=False` suppresses the line, never the counter.
def drop(reason: str, message: str, *args, emit_log: bool = True, **fields):
    """Count a dropped message and warn about it, from one `reason`.

    `reason` must have a mapping in metrics.py's COUNTER_MAP; test_structured_logging.py asserts
    that every reason reachable here does.
    """
    count(f"dropped_{reason}")
    if emit_log:
        logger.warning(message, *args, extra={"reason": reason, **fields})

def diagnose_device_identity(wire_id: str):
    """
    Explain how `wire_id` fails the wire-identity contract, or return None if it is acceptable.

    A bare legacy name is not an error during the migration window; only a malformed attempt at a
    platform-issued id (right prefix, wrong shape) is.
    """
    if DEVICE_ID_PATTERN.match(wire_id):
        return None

    lowered = wire_id.lower()
    if not lowered.startswith(("dev", "gwy")):
        return None  # A legacy name. Handled by the deprecation path, not the quarantine path.

    if lowered.startswith("gwy"):
        return (
            "'%s' is an edge gateway id, but it was published in the device position of the "
            "topic. Check that the gateway is not publishing DBIRTH/DDATA under its own id."
            % wire_id
        )

    if len(wire_id) != SPARKPLUG_ID_LENGTH:
        return (
            "device id '%s' is %d characters; expected %d ('dev' followed by 21 hex characters). "
            "The id is most likely truncated or padded in the gateway configuration -- copy it "
            "again from the device's page in the dashboard."
            % (wire_id, len(wire_id), SPARKPLUG_ID_LENGTH)
        )

    return (
        "device id '%s' is the correct length but contains characters outside 0-9 and a-f after "
        "the 'dev' prefix. Copy it again from the device's page in the dashboard."
        % wire_id
    )

def _throttled(store: dict, key: str, interval: int) -> bool:
    """True at most once per `interval` seconds per key, so a 30s heartbeat cannot flood the log."""
    now = time.time()
    if now - store.get(key, 0) > interval:
        store[key] = now
        return True
    return False

# -----------------------------------------------------------------------------
# Sparkplug B Alias Resolution
# -----------------------------------------------------------------------------
def alias_key(group_id, edge_node_id):
    """The alias table key. Normalised so a missing group and an empty one are the same node."""
    return (group_id or "", edge_node_id or "")

def register_birth_aliases(group_id, edge_node_id, payload, reset=False):
    """
    Record the alias -> name bindings a birth certificate declares. Returns the number stored.

    `reset` clears the node's table first and is used for NBIRTH only: an NBIRTH invalidates all
    prior state for the node and its devices. A DBIRTH merges.
    """
    key = alias_key(group_id, edge_node_id)
    declared = {}
    for metric in getattr(payload, "metrics", []):
        if not metric.name:
            continue
        if not metric.HasField("alias"):
            continue
        declared[metric.alias] = metric.name

    with _alias_lock:
        if reset:
            _alias_map[key] = {}
        table = _alias_map.setdefault(key, {})

        stored = 0
        for alias, name in declared.items():
            # Overwriting an existing alias is free; only a NEW one can grow the table, so the
            # cap is checked against additions rather than against the declaration size.
            if alias not in table and len(table) >= MAX_ALIASES_PER_NODE:
                logger.warning(
                    "Alias table for edge node '%s' is at its %d-entry cap; ignoring further "
                    "aliases. Check that the gateway is not re-birthing with fresh alias numbers.",
                    edge_node_id, MAX_ALIASES_PER_NODE
                )
                break
            table[alias] = name
            stored += 1

    if stored:
        logger.info(
            "Registered %d metric alias(es) from %s for edge node '%s'",
            stored, "NBIRTH" if reset else "DBIRTH", edge_node_id
        )
    return stored

def resolve_metric_name(group_id, edge_node_id, metric):
    """
    The metric's name, resolving an alias-only metric through its edge node's birth map.

    Returns None when neither a name nor a resolvable alias is present, which the caller must
    treat as "this node's birth has not been seen".
    """
    if metric.name:
        return metric.name
    if not metric.HasField("alias"):
        return None
    with _alias_lock:
        return _alias_map.get(alias_key(group_id, edge_node_id), {}).get(metric.alias)

# -----------------------------------------------------------------------------
# NCMD Rebirth Requests
# -----------------------------------------------------------------------------
def build_rebirth_payload():
    """A Sparkplug NCMD payload carrying `Node Control/Rebirth` = true."""
    payload = sparkplug_b_pb2.Payload()
    payload.timestamp = int(time.time() * 1000)
    metric = payload.metrics.add()
    metric.name = REBIRTH_METRIC_NAME
    metric.datatype = 11  # Boolean
    metric.boolean_value = True
    return payload.SerializeToString()

def request_node_rebirth(client, group_id, edge_node_id, force=False):
    """
    Ask an edge node to republish its birth certificates. Returns True if a request was sent.

    The alias table is in-memory, so this is what closes the cold start after a restart. Rate
    limited per node so a gateway that never responds is not asked once per message.

    `force` skips the wait and still stamps the throttle. Used by broker capture and the
    dashboard's rebirth requests, where the ceiling is a person pressing a button rather than the
    plant's message rate; without it the startup and gap requests usually leave the throttle spent
    by the time a capture opens. See ingestion/README.md -> "Rebirth Requests (NCMD)".
    """
    if client is None or not edge_node_id:
        return False

    key = "%s/%s" % (group_id or "", edge_node_id)
    if not _throttled(_rebirth_requested, key, REBIRTH_REQUEST_INTERVAL_SECONDS) and not force:
        return False
    if force:
        # Consume the window even when the check above already had, so the two paths leave the same
        # state behind and an ordinary gap cannot chase a capture's request straight away.
        _rebirth_requested[key] = time.time()

    topic = "spBv1.0/%s/NCMD/%s" % (group_id or "", edge_node_id)
    try:
        client.publish(topic, build_rebirth_payload(), qos=0, retain=False)
    except Exception as e:
        # The throttle stays consumed: a broker that refuses this publish will refuse the next
        # one too, and retrying per message is the flood this function exists to prevent.
        logger.error("Could not publish a rebirth request to '%s': %s", topic, e)
        return False

    logger.warning(
        "REBIRTH REQUESTED: published '%s' to '%s'. Its alias table is unknown, so DDATA metrics "
        "carrying only an alias cannot be resolved until it re-births. Next request no sooner "
        "than %ds.",
        REBIRTH_METRIC_NAME, topic, REBIRTH_REQUEST_INTERVAL_SECONDS
    )
    return True

# -----------------------------------------------------------------------------
# Sparkplug Sequence Tracking
# -----------------------------------------------------------------------------
def check_message_sequence(group_id, edge_node_id, msg_type, payload, client=None):
    """
    Follow an edge node's Sparkplug `seq` counter and ask for a rebirth when it jumps.

    Returns True if the message arrived in sequence (or could not be judged), False on a gap.

    Under report-by-exception a dropped message is a lost state change that nothing restates;
    `seq` skipping is the only evidence, and a rebirth re-declares every metric at its current
    value. NDEATH is excluded (a Last Will carries bdSeq, not a live seq). The expectation resyncs
    on a gap so one drop does not become a permanent alarm.
    """
    if msg_type == "NDEATH" or not payload.HasField("seq"):
        return True

    seq = payload.seq % 256
    key = alias_key(group_id, edge_node_id)

    with _seq_lock:
        # Per the specification NBIRTH restarts the run at zero, so it is a resynchronisation
        # point rather than something to check: whatever we believed before it is void.
        if msg_type == "NBIRTH":
            _last_seq[key] = seq
            return True

        previous = _last_seq.get(key)
        _last_seq[key] = seq

    # No baseline yet -- this daemon started mid-run. Adopting the observed value is right;
    # calling it a gap would fire a rebirth at every node on every restart.
    if previous is None:
        return True

    expected = (previous + 1) % 256
    if seq == expected:
        return True

    # A redelivered QoS-1 message repeats a seq we have already seen. That is the broker doing
    # its job, not a loss, and the historian's ON CONFLICT DO NOTHING already absorbs it.
    if seq == previous:
        logger.debug(
            "Duplicate %s seq %d from edge node '%s' (redelivery); ignoring.",
            msg_type, seq, edge_node_id
        )
        return True

    missed = (seq - expected) % 256

    # The message is still processed; only the counters are added. Both counters, because one gap
    # of 200 and 200 gaps of 1 are different faults. The 255 -> 0 wrap and the first message after
    # a restart never reach here (asserted in test_sequence_gap_metrics.py).
    count_labelled("acs_ingestion_sequence_gaps_total", {"edge_node": edge_node_id})
    count_labelled(
        "acs_ingestion_sequence_messages_missed_total", {"edge_node": edge_node_id}, missed
    )

    # Expected once after a start: the first message seen carries a seq far ahead of the 0
    # expected, and that is a correct report of messages missed while nothing was listening. CI
    # waits for this daemon to be consuming (scripts/wait-for-ingestion-consuming.sh) before the
    # conformance suite publishes, so a gap burst in CI means what it says.
    requested = request_node_rebirth(client, group_id, edge_node_id)
    logger.warning(
        "SEQUENCE GAP: edge node '%s' sent %s with seq %d, expected %d -- %d message(s) lost or "
        "reordered. Under report-by-exception an unseen change is never restated, so any metric "
        "carried by those messages is now stale here.%s",
        edge_node_id, msg_type, seq, expected, missed,
        " A rebirth has been requested." if requested
        else " A rebirth was not requested (throttled or no broker client)."
    )
    return False

# -----------------------------------------------------------------------------
# Device Liveness Watchdog
# -----------------------------------------------------------------------------
def mark_device_seen(device):
    """Note that this device has just been heard from. In-memory only; writes nothing."""
    if not device or not device.get("id"):
        return
    with _device_seen_lock:
        _device_seen[device["id"]] = {
            "at": time.monotonic(),
            "name": device.get("name") or device.get("sparkplug_id") or device["id"],
        }

def forget_device_seen(device_id):
    """Stop tracking a device -- it has died explicitly, or has just been flipped OFFLINE."""
    with _device_seen_lock:
        _device_seen.pop(device_id, None)

def stale_device_ids(now=None, timeout=None):
    """
    Devices heard from in this process that have since been quiet for longer than `timeout`.

    Only devices this process has seen are candidates: seeding from the database would mark a
    whole fleet OFFLINE on every restart, one audit row each.
    """
    timeout = DEVICE_OFFLINE_TIMEOUT_SECONDS if timeout is None else timeout
    if timeout <= 0:
        return []
    now = time.monotonic() if now is None else now
    with _device_seen_lock:
        return [
            (device_id, entry["name"])
            for device_id, entry in _device_seen.items()
            if now - entry["at"] > timeout
        ]

def sweep_stale_devices(now=None, timeout=None):
    """
    Flip quiet devices OFFLINE. Returns the ids written.

    Write-on-change: log_digital_thread_event() fires on every UPDATE to `devices`, so the gate
    refuses a no-op write and the device is dropped from tracking afterwards, giving one write per
    quiet period.
    """
    if not supabase_client:
        return []

    written = []
    for device_id, name in stale_device_ids(now, timeout):
        try:
            # The gate refuses a no-op write (`IS DISTINCT FROM 'OFFLINE'`); no filter is needed here.
            supabase_client.rpc("ingest_mark_device_offline", {
                "p_device_id": device_id,
            }).execute()
            logger.warning(
                "WATCHDOG: device '%s' has published nothing for over %ds and no DDEATH arrived; "
                "marked OFFLINE.",
                name, DEVICE_OFFLINE_TIMEOUT_SECONDS if timeout is None else timeout
            )
            written.append(device_id)
        except Exception as e:
            # Left in the map so the next sweep retries; a failed write must not silently
            # convince us the device was dealt with.
            logger.error("Watchdog could not mark device '%s' OFFLINE: %s", name, e)
            continue
        forget_device_seen(device_id)

    return written

def start_device_watchdog():
    """
    Sweep for quiet devices every DEVICE_WATCHDOG_INTERVAL_SECONDS. No-op when disabled.

    A daemon thread that swallows its own errors: a failing sweep must not take down ingestion.
    """
    if DEVICE_OFFLINE_TIMEOUT_SECONDS <= 0:
        logger.info("Device liveness watchdog disabled (DEVICE_OFFLINE_TIMEOUT_SECONDS=0).")
        return

    def sweep():
        while True:
            # Sleep first: at startup the map is empty and a sweep would do nothing anyway.
            time.sleep(DEVICE_WATCHDOG_INTERVAL_SECONDS)
            try:
                sweep_stale_devices()
            except Exception as exc:  # noqa: BLE001 - see docstring
                logger.warning("Device watchdog sweep failed: %s", exc)

    threading.Thread(target=sweep, name="device-watchdog", daemon=True).start()
    logger.info(
        "Device liveness watchdog running: quiet for more than %ds -> OFFLINE, swept every %ds.",
        DEVICE_OFFLINE_TIMEOUT_SECONDS, DEVICE_WATCHDOG_INTERVAL_SECONDS
    )

# Throttle for traffic refused because the DEVICE is archived, keyed by wire id. A machine that
# was decommissioned in the dashboard but not unplugged goes on publishing at its own cadence,
# so the refusal has to be legible without being the whole log.
_archived_device_warned = {}
ARCHIVED_DEVICE_WARN_INTERVAL_SECONDS = 300

def resolve_device(wire_id: str, use_cache: bool = True, include_archived: bool = False):
    """
    Resolve an id seen on the wire to its `devices` row, refusing one that has been archived.

    `include_archived` is for callers that describe the refusal themselves -- the three message
    paths, which name the message kind they are dropping and count it once each. They check
    `is_archived` for themselves. The default refusal is what covers every other caller.

    ARCHIVING A DEVICE REVOKES NOTHING. A gateway's archive rotates its broker credential, so the
    appliance eventually loses its connection; a device has no account of its own, and its gateway
    goes on publishing for the machines still in service. Without this, an archived device's
    readings keep landing in the historian under an asset no page will show.
    """
    row = _resolve_device_row(wire_id, use_cache)
    if row is None or include_archived or not row.get("is_archived"):
        return row

    # Named apart from "unregistered" for the reason resolve_gateway() names its own refusal: the
    # two answers send an operator to different fixes -- register the device, or restore it.
    drop(
        "device_archived",
        "Dropping traffic for device '%s' (%s): the device is ARCHIVED. Restore it on the "
        "Archived Entities page to accept its readings again.",
        wire_id, row.get("name"),
        emit_log=_throttled(_archived_device_warned, wire_id, ARCHIVED_DEVICE_WARN_INTERVAL_SECONDS),
        device=wire_id,
    )
    return None

def _resolve_device_row(wire_id: str, use_cache: bool = True):
    """
    Resolve an id seen on the wire to its `devices` row, in order of precedence:

      1. sparkplug_id      -- the platform-issued id.
      2. reported_identity -- a third-party device's own factory-preset id.
      3. id                -- the Factory+ `Instance_UUID`; tried only for a UUID-shaped wire id.
      4. name              -- legacy devices. Warns.

    Returns the row (with `_identity_source` attached) or None if unregistered. Raises
    DirectoryUnavailable when the directory cannot be reached.
    See ingestion/README.md -> "Resolution precedence".
    """
    if not supabase_client:
        raise DirectoryUnavailable(
            "Supabase client is not configured; cannot resolve device '%s'" % wire_id
        )

    if use_cache:
        hit, row = _device_cache.get(wire_id)
        if hit:
            # `row` may legitimately be None -- the negative entry. Returning it is the point:
            # an unregistered device must not cost a directory round trip per message.
            return row

    # A well-formed platform id is never also a legacy name, so skip that round-trip.
    lookups = [("sparkplug_id", SOURCE_SPARKPLUG_ID), ("reported_identity", SOURCE_REPORTED_IDENTITY)]
    if UUID_PATTERN.match(wire_id):
        # Factory+ Instance_UUID. Guarded on the shape because `devices.id` is a uuid column:
        # PostgREST rejects a non-UUID comparison with a 400, so an unguarded arm would turn
        # every ordinary sparkplug_id lookup into a wasted failing round-trip.
        lookups.append(("id", SOURCE_INSTANCE_UUID))
    if not DEVICE_ID_PATTERN.match(wire_id):
        lookups.append(("name", SOURCE_LEGACY_NAME))

    try:
        for column, source in lookups:
            res = supabase_client.table("devices").select(_DEVICE_COLUMNS).eq(column, wire_id).execute()
            rows = res.data if res else []
            if not rows:
                continue

            if len(rows) > 1:
                # reported_identity is deliberately non-unique: duplicates are a real
                # misconfiguration that must surface in the queue rather than abort ingestion.
                logger.warning(
                    "Ambiguous device identity: %d devices match %s='%s'. Using '%s'. Two gateways "
                    "are probably configured with the same device id.",
                    len(rows), column, wire_id, rows[0].get("name")
                )

            row = dict(rows[0])
            row["_identity_source"] = source
            if source == SOURCE_LEGACY_NAME and _throttled(
                _legacy_identity_warned, wire_id, LEGACY_IDENTITY_WARN_INTERVAL_SECONDS
            ):
                logger.warning(
                    "DEPRECATED IDENTITY: device '%s' was matched by name. Reconfigure its gateway to "
                    "publish sparkplug_id '%s' instead; name-based matching will be removed.",
                    wire_id, row.get("sparkplug_id")
                )

            _device_cache.set(wire_id, row)
            return row

        _device_cache.set(wire_id, None)
        return None
    except Exception as e:
        # Not cached and not returned as None: a transient failure must neither pin the device to
        # "unregistered" for the TTL nor let process_dbirth() quarantine it. See DirectoryUnavailable.
        logger.error("Error resolving device identity '%s' in Supabase: %s", wire_id, e)
        raise DirectoryUnavailable(str(e)) from e

# Throttle for traffic refused because its edge node is archived, keyed by edge node id. An
# appliance that has not been switched off beats every 30s and publishes its devices besides, so
# the refusal has to be legible without being the whole log.
_archived_gateway_warned = {}
ARCHIVED_GATEWAY_WARN_INTERVAL_SECONDS = 300

def resolve_gateway(wire_id: str, group_id: str = None, include_archived: bool = False):
    """
    Resolve an edge node to its `gateways` row, refusing one that has been archived.

    `include_archived` is for callers that describe the refusal (verify_gateway_binding() writes
    the quarantine reason an operator reads); they check `is_archived` themselves.

    Archived is a refusal for the whole edge node, devices included. Broker credential revocation
    on archive is asynchronous and inert without GATEWAY_REVOKE_SECRET, so a retired appliance
    may still connect; without this it would resurrect its row to ONLINE.
    """
    row = _resolve_gateway_row(wire_id, group_id)
    if row is None or include_archived or not row.get("is_archived"):
        return row

    # NAMED SEPARATELY FROM "unregistered", which is the whole reason this is not simply a filter
    # in the query. "Received NDATA from unregistered edge node" sends an operator hunting a
    # provisioning fault; the truth is that somebody archived it, and that is a different fix.
    drop(
        "gateway_archived",
        "Dropping traffic from edge node '%s' (%s): the gateway is ARCHIVED. Its broker "
        "credential should have been revoked when it was archived (archived migration 0038) -- that it "
        "can still publish means revocation has not landed, or GATEWAY_REVOKE_SECRET is unset "
        "on this deployment. Un-archive the gateway to accept it again.",
        wire_id, row.get("name"),
        emit_log=_throttled(_archived_gateway_warned, wire_id, ARCHIVED_GATEWAY_WARN_INTERVAL_SECONDS),
        edge_node=wire_id,
    )
    return None

def _resolve_gateway_row(wire_id: str, group_id: str = None):
    """
    Resolve an edge node to its `gateways` row.

    The address is (group, node), as Factory+ addresses an edge node. Resolution order:

      1. (sparkplug_group, sparkplug_id) -- the current scheme.
      2. sparkplug_id alone              -- group-agnostic migration path. Warns, throttled.
      3. name                            -- legacy. Warns.

    Gateways are never auto-created: an unregistered edge node is logged and dropped.
    """
    if not wire_id:
        return None
    if not supabase_client:
        raise DirectoryUnavailable(
            "Supabase client is not configured; cannot resolve edge node '%s'" % wire_id
        )

    # Keyed by the PAIR. A cache keyed on the node alone would hand a hit from one group to a
    # request from another, which is precisely the collision this change exists to close.
    cache_key = (group_id or "", wire_id)
    hit, row = _gateway_cache.get(cache_key)
    if hit:
        # None here is the negative entry, not a miss. See TTLCache.get().
        return row

    columns = _GATEWAY_COLUMNS
    try:
        # 1. Group-qualified.
        if group_id:
            res = supabase_client.table("gateways").select(columns).eq(
                "sparkplug_group", group_id
            ).eq("sparkplug_id", wire_id).execute()
            rows = res.data if res else []
            if rows:
                row = dict(rows[0])
                row["_identity_source"] = SOURCE_SPARKPLUG_ID
                _gateway_cache.set(cache_key, row)
                return row

        # 2/3. Group-agnostic fallback, then the legacy name arm.
        lookups = ["sparkplug_id"] if GATEWAY_ID_PATTERN.match(wire_id) else ["sparkplug_id", "name"]
        for column in lookups:
            res = supabase_client.table("gateways").select(columns).eq(column, wire_id).execute()
            rows = res.data if res else []
            if not rows:
                continue

            row = dict(rows[0])
            row["_identity_source"] = (
                SOURCE_SPARKPLUG_ID if column == "sparkplug_id" else SOURCE_LEGACY_NAME
            )

            if column == "name":
                if _throttled(_legacy_identity_warned, wire_id, LEGACY_IDENTITY_WARN_INTERVAL_SECONDS):
                    logger.warning(
                        "DEPRECATED IDENTITY: edge node '%s' was matched by name. Reconfigure it to "
                        "publish sparkplug_id '%s' instead; name-based matching will be removed.",
                        wire_id, row.get("sparkplug_id")
                    )
            elif group_id and row.get("sparkplug_group") != group_id:
                # Resolved, but under the wrong group. NOT a refusal: a fleet is reconfigured one
                # gateway at a time, and refusing here would strand every device behind a node
                # whose group had not been corrected yet.
                if _throttled(
                    _legacy_identity_warned, "group:%s" % wire_id, LEGACY_IDENTITY_WARN_INTERVAL_SECONDS
                ):
                    logger.warning(
                        "DEPRECATED IDENTITY: edge node '%s' published under Sparkplug group '%s' but "
                        "is registered under '%s'. Matched group-agnostically. Set gateways."
                        "sparkplug_group to '%s', or reconfigure the gateway to publish under '%s'; "
                        "group-agnostic matching will be removed.",
                        wire_id, group_id, row.get("sparkplug_group"),
                        group_id, row.get("sparkplug_group") or DEFAULT_SPARKPLUG_GROUP
                    )

            _gateway_cache.set(cache_key, row)
            return row

        _gateway_cache.set(cache_key, None)
        return None
    except Exception as e:
        # Raised, not returned: an unreachable directory must not read as "not registered", which
        # verify_gateway_binding() would turn into a quarantine reason.
        logger.error("Error resolving gateway identity '%s' in Supabase: %s", wire_id, e)
        raise DirectoryUnavailable(str(e)) from e

# -----------------------------------------------------------------------------
# Directory refresh
# -----------------------------------------------------------------------------
# resolve_device() and _resolve_gateway_row() miss their caches once per entity per
# CACHE_TTL_SECONDS, and each miss is a PostgREST round trip on the callback thread: N devices
# cost N/5 round trips a second. This thread reads the whole directory in one request per table
# per pass and re-fills both caches, so the hot path misses only for an id the directory does
# not hold. A pass that fails leaves the caches alone; entries expire on their own TTL and the
# per-entity lookup takes over, which is the behaviour without the thread.
# See ingestion/README.md -> "The directory refresher".

# PostgREST's default max-rows. Paged so a larger fleet still arrives whole.
DIRECTORY_PAGE_SIZE = 1000

def _directory_rows(table, columns):
    """Every row of `table`, paged."""
    rows = []
    start = 0
    while True:
        res = supabase_client.table(table).select(columns).range(
            start, start + DIRECTORY_PAGE_SIZE - 1
        ).execute()
        page = list(res.data or []) if res else []
        rows.extend(page)
        if len(page) < DIRECTORY_PAGE_SIZE:
            return rows
        start += DIRECTORY_PAGE_SIZE

def refresh_directory_caches():
    """
    One pass: re-fill the device and gateway caches from the directory.

    Returns (devices, gateways) row counts. Each cached row is its own dict, as resolve_device()
    would have built it, and the replacement is per key: a row the DBIRTH path mutated in place
    since the pass began is superseded by the directory's copy, which already carries that write.
    """
    devices = _directory_rows("devices", _DEVICE_COLUMNS)
    # reported_identity first so that a wire id that is one device's sparkplug_id and another's
    # reported_identity resolves as resolve_device() resolves it: sparkplug_id wins.
    for column, source in (("reported_identity", SOURCE_REPORTED_IDENTITY),
                           ("sparkplug_id", SOURCE_SPARKPLUG_ID)):
        for row in devices:
            key = row.get(column)
            if not key:
                continue
            cached = dict(row)
            cached["_identity_source"] = source
            _device_cache.set(key, cached)

    gateways = _directory_rows("gateways", _GATEWAY_COLUMNS)
    for row in gateways:
        key = row.get("sparkplug_id")
        if not key:
            continue
        cached = dict(row)
        cached["_identity_source"] = SOURCE_SPARKPLUG_ID
        # The same (group, node) key _resolve_gateway_row() uses. A node publishing under a group
        # other than its registered one still takes the per-entity path, which warns about it.
        _gateway_cache.set((row.get("sparkplug_group") or "", key), cached)

    if len(_device_cache) >= _device_cache.maxsize:
        logger.warning(
            "The directory holds more device ids (%d) than MAX_ENTITIES_PER_CACHE (%d): the "
            "cache cannot hold the fleet and resolution falls back to per-entity lookups for "
            "whatever it evicts. Raise MAX_ENTITIES_PER_CACHE.",
            len(_device_cache), _device_cache.maxsize,
        )
    return len(devices), len(gateways)

def start_directory_refresher():
    """Warm both caches now, then keep them warm every DIRECTORY_REFRESH_SECONDS."""
    if DIRECTORY_REFRESH_SECONDS <= 0:
        logger.info("Directory refresh is disabled (DIRECTORY_REFRESH_SECONDS=0); every cache "
                    "miss is a directory round trip.")
        return
    if not supabase_client:
        return

    def loop():
        while True:
            try:
                refresh_directory_caches()
            except Exception as exc:  # noqa: BLE001 - a warm-up must never stop ingestion
                logger.warning(
                    "Directory refresh failed (%s); resolution falls back to per-entity lookups "
                    "until the next pass.", exc,
                )
            time.sleep(DIRECTORY_REFRESH_SECONDS)

    threading.Thread(target=loop, name="directory-refresher", daemon=True).start()

# -----------------------------------------------------------------------------
# Sparkplug B Ingestion Handlers
# -----------------------------------------------------------------------------
def _timestamp_is_sane(dt: datetime, now: datetime = None) -> bool:
    """
    True if `dt` falls inside the telemetry sanity window.

    A value far outside it is a clock fault or a forgery: it would land outside retention, in a
    compressed chunk that rejects the write, or far enough ahead to distort every axis.
    """
    now = now or datetime.now(timezone.utc)
    delta = (dt - now).total_seconds()
    return -TELEMETRY_MAX_AGE_SECONDS <= delta <= TELEMETRY_MAX_FUTURE_SECONDS

def verify_gateway_binding(device: dict, gateway_wire_id: str, group_id: str = None):
    """
    Check that the edge node publishing this message is the one the device is bound to.

    `group_id` scopes the lookup: the address is (group, node).

    Returns None when the message may be trusted, or a quarantine reason string. Never raises: a
    lookup failure is reported as a mismatch.

    Not a mismatch: a device with no `gateway_id` (binding is set at approval, never here) and a
    node-level message (no device segment). How the device was resolved does not exempt it: the
    broker ACL pins the edge-node segment of a topic and leaves the device segment free, so this
    is the only tier checking the device segment.
    Threat model: ingestion/README.md -> "Gateway Binding".
    """
    if not device:
        return None

    bound_gateway_id = device.get("gateway_id")
    if not bound_gateway_id:
        return None

    # The unfiltered row, so the quarantine reason can say which refusal happened. An archived
    # gateway answered as None would read as "never registered" in `devices.quarantine_reason`.
    gateway = resolve_gateway(gateway_wire_id, group_id, include_archived=True)

    # An unregistered edge node speaking for a *registered, bound* device. resolve_gateway()'s
    # contract is that unregistered edge nodes are dropped; that was only ever enforced on the
    # node-level path, so a device message via an unknown edge node was accepted.
    if gateway is None:
        return "%s: device is bound to a gateway but the publishing edge node '%s' is not registered" % (
            REASON_GATEWAY_MISMATCH, gateway_wire_id
        )

    # Checked before the id comparison: a device bound to the archived gateway that is publishing
    # for it matches by construction.
    if gateway.get("is_archived"):
        return "%s: the publishing edge node '%s' is ARCHIVED. Un-archive the gateway to accept its telemetry again" % (
            REASON_GATEWAY_MISMATCH, gateway_wire_id
        )

    if gateway["id"] != bound_gateway_id:
        return "%s: device is bound to gateway '%s' but the message was published by '%s'" % (
            REASON_GATEWAY_MISMATCH, device.get("gateway_id"), gateway.get("sparkplug_id") or gateway_wire_id
        )

    return None

def store_birth_parameters(sparkplug_id: str, payload):
    """
    Persist the metrics carried by a DBIRTH to `asset_config`, for the device Config view.

    Keyed by `sparkplug_id`, so a rename keeps the parameters attached. Stored for quarantined
    devices too, so an administrator can inspect a device before approving it.
    """
    if not supabase_client:
        return

    rows = []
    for metric in payload.metrics:
        # Asset_ID and Asset_Name carry identity, not configuration -- identity lives in the
        # topic and in `devices`, so storing them as parameters would just be a stale copy.
        if not metric.name or metric.name in IDENTITY_METRICS:
            continue

        # No `asset_id` and no `updated_at`: the gate pins both. It takes the asset once as an
        # argument and ignores whatever the row objects carry, so a malformed batch cannot write
        # parameters against somebody else's asset -- see 0047.
        row = {
            "metric_name": metric.name,
            "val_double": None,
            "val_string": None,
            "val_bool": None,
            "datatype": metric.datatype if metric.HasField("datatype") else None,
        }

        if metric.HasField("int_value"):
            row["val_double"] = float(metric.int_value)
        elif metric.HasField("long_value"):
            row["val_double"] = float(metric.long_value)
        elif metric.HasField("float_value"):
            row["val_double"] = float(metric.float_value)
        elif metric.HasField("double_value"):
            row["val_double"] = metric.double_value
        elif metric.HasField("boolean_value"):
            row["val_bool"] = metric.boolean_value
        elif metric.HasField("string_value"):
            row["val_string"] = metric.string_value
        else:
            continue

        rows.append(row)

    if not rows:
        return

    try:
        # uq_asset_config_metric (asset_id, metric_name) makes this a per-metric upsert. One call for
        # the whole batch: a per-metric gate would be one round trip per metric on the hot path.
        supabase_client.rpc("ingest_store_birth_parameters", {
            "p_asset_id": sparkplug_id,
            "p_rows": rows,
        }).execute()
        logger.info("DBIRTH: Stored %d birth parameters for device '%s'", len(rows), sparkplug_id)
    except Exception as e:
        logger.error("Error storing DBIRTH parameters for '%s': %s", sparkplug_id, e, exc_info=True)

def extract_declared_metrics(payload):
    """
    The set of metric names a birth certificate declares, sorted, minus the identity metrics.

    Unlike store_birth_parameters(), a metric declared with no value still counts. This records
    what was observed; whether it falls outside the schema is derived at read time.
    """
    return sorted({
        metric.name for metric in payload.metrics
        if metric.name and metric.name not in IDENTITY_METRICS
    })

def record_declared_metrics(device: dict, payload):
    """
    Persist the birth-declared metric names onto the device row, only when the set has changed.

    log_digital_thread_event() fires on every UPDATE to `devices`, so an unchanged write on every
    rebirth would append an audit row each time.
    """
    if not supabase_client or not device:
        return

    declared = extract_declared_metrics(payload)
    if device.get("last_birth_metrics") == declared:
        return

    try:
        # The change check above saves a round trip; the gate carries the same `IS DISTINCT FROM`
        # test, so a stale cache entry cannot cause an unchanged rewrite.
        supabase_client.rpc("ingest_record_declared_metrics", {
            "p_device_id": device["id"],
            "p_metrics": declared,
            "p_observed_at": datetime.now(timezone.utc).isoformat(),
        }).execute()

        # resolve_device caches this same dict, so updating it in place keeps the cached copy
        # in step and stops the next birth inside the TTL from re-detecting the same change.
        device["last_birth_metrics"] = declared

        logger.info(
            "DBIRTH: device '%s' declared metric set changed -> %d metric(s): %s",
            device.get("name"), len(declared), ", ".join(declared) or "(none)"
        )
    except Exception as e:
        logger.error(
            "Error recording declared metrics for '%s': %s", device.get("name"), e, exc_info=True
        )

def extract_name_hint(payload):
    """
    The device's self-reported friendly name, used only as the initial label for a new device.

    Never applied to an existing row: the friendly name is platform-owned.
    """
    for metric in payload.metrics:
        if metric.name == 'Asset_Name' and metric.HasField('string_value'):
            return metric.string_value.strip() or None
    return None

def quarantine_new_device(wire_id: str, gateway_wire_id: str, reason: str, payload,
                          group_id: str = None):
    """
    Insert a newly discovered device with is_quarantined = True, and return the created row.

    The arriving edge node is recorded on the row so approval does not need the gateway re-picked.
    """
    # Unfiltered, so the log can say WHICH of the two refusals this is. The device is still left
    # with no gateway either way: attaching a newly discovered one to an archived appliance would
    # resurrect a retired gateway's device list, and the operator picks a gateway at approval.
    gateway = resolve_gateway(gateway_wire_id, group_id, include_archived=True)
    if gateway is not None and gateway.get("is_archived"):
        logger.warning(
            "Quarantining device '%s' from ARCHIVED edge node '%s' (%s): it will have no gateway "
            "assigned until one is chosen at approval.",
            wire_id, gateway_wire_id, gateway.get("name")
        )
        gateway = None
    elif gateway is None:
        logger.warning(
            "Quarantining device '%s' from unregistered edge node '%s': it will have no gateway "
            "assigned until one is chosen at approval.", wire_id, gateway_wire_id
        )

    now = datetime.now(timezone.utc).isoformat()

    # `status` and `is_quarantined` are pinned by the gate; this is the quarantine path only.
    # `last_birth_metrics` is carried here so a new device produces one digital_thread entry rather
    # than an insert chased by an update.
    res = supabase_client.rpc("ingest_register_quarantined_device", {
        "p_name": extract_name_hint(payload) or wire_id,
        "p_gateway_id": gateway["id"] if gateway else None,
        "p_reported_identity": wire_id,
        "p_quarantine_reason": reason,
        "p_identity_source": SOURCE_REPORTED_IDENTITY,
        "p_declared_metrics": extract_declared_metrics(payload),
        "p_observed_at": now,
    }).execute()
    rows = res.data if res else []
    row = dict(rows[0]) if rows else None

    # sparkplug_id is a generated column, so it comes back in the returned representation.
    # If the client was configured not to return one, resolve it rather than guessing.
    if row and not row.get("sparkplug_id"):
        row = resolve_device(wire_id, use_cache=False)
    if row:
        row["_identity_source"] = SOURCE_REPORTED_IDENTITY
        _device_cache.set(wire_id, row)

    logger.warning(
        "QUARANTINE ALERT: device '%s' announced DBIRTH via edge node '%s' but is not registered. "
        "Inserted with is_quarantined=True (%s).", wire_id, gateway_wire_id, reason
    )
    return row

def process_dbirth(wire_id: str, gateway_wire_id: str, payload, quarantine_reason: str = None,
                   group_id: str = None):
    """
    On Sparkplug B DBIRTH: resolve the device by its wire identity. If unregistered, insert it
    quarantined, recording the id it published under and why it was held. Birth certificate
    metrics are recorded to `asset_config` either way.

    `quarantine_reason` is supplied when the identity itself was already found faulty. A
    registered device is also checked against the publishing edge node (verify_gateway_binding)
    and re-quarantined on a mismatch.
    """
    logger.info("Processing DBIRTH for device '%s' via edge node '%s'", wire_id, gateway_wire_id)

    # Before the registration check, deliberately. The alias table is in-memory and keyed by edge
    # node, so recording it costs nothing and must not depend on whether this device is registered
    # -- a quarantined device's later DDATA still has to be *decodable* to be reported on.
    register_birth_aliases(group_id, gateway_wire_id, payload)

    if not supabase_client:
        logger.warning("Supabase client unavailable. Skipping Supabase DBIRTH check for '%s'", wire_id)
        return

    try:
        try:
            # Unfiltered, so an archived device is not answered as None: that answer quarantines,
            # and quarantining would mint a SECOND row for a machine this stack already holds
            # archived -- the identity the operator kept by archiving rather than deleting.
            device = resolve_device(wire_id, use_cache=False, include_archived=True)
        except DirectoryUnavailable as e:
            # Drop the birth and change nothing: answering "unregistered" here would quarantine a
            # legitimate device. A birth is repeated (the flow rebirths on a timer and the daemon asks
            # for one on an unknown alias), and the aliases from this payload are already registered.
            # The most expensive drop the daemon makes: later alias-only DDATA from this node is
            # unresolvable until the next rebirth.
            drop(
                "dbirth_directory_unavailable",
                "DIRECTORY UNAVAILABLE: dropping DBIRTH for '%s' without registering it (%s). "
                "The device is NOT quarantined -- this is a transport fault, not an identity "
                "one. The next birth certificate will resolve normally.",
                wire_id, e,
                device=wire_id,
            )
            return

        if device is not None and device.get("is_archived"):
            drop(
                "device_archived",
                "Dropping DBIRTH for ARCHIVED device '%s' (%s) on edge node '%s'. It is NOT "
                "quarantined -- the device is known and was retired deliberately. Restore it on "
                "the Archived Entities page to accept it again.",
                wire_id, device.get("name"), gateway_wire_id,
                emit_log=_throttled(
                    _archived_device_warned, wire_id, ARCHIVED_DEVICE_WARN_INTERVAL_SECONDS),
                device=wire_id,
            )
            return

        if device is None:
            device = quarantine_new_device(
                wire_id, gateway_wire_id, quarantine_reason or REASON_UNKNOWN_DEVICE, payload,
                group_id=group_id
            )
            if device is None:
                logger.error("Failed to record quarantined device '%s'; dropping its birth certificate.", wire_id)
                return
        elif device.get("is_quarantined"):
            logger.warning("QUARANTINE NOTICE: DBIRTH received for quarantined device '%s'", device.get("name"))
        else:
            # An identity fault already diagnosed by the caller takes precedence: it describes
            # the id itself, which is the more fundamental problem of the two.
            hold_reason = quarantine_reason or verify_gateway_binding(
                device, gateway_wire_id, group_id)

            if hold_reason:
                # A registered device publishing a faulty identity, or announced by a gateway it is not
                # bound to. Re-quarantine it. `is_quarantined` is pinned true by the gate.
                supabase_client.rpc("ingest_requarantine_device", {
                    "p_device_id": device["id"],
                    "p_quarantine_reason": hold_reason,
                    "p_reported_identity": wire_id,
                }).execute()
                _device_cache.pop(wire_id, None)
                logger.warning(
                    "QUARANTINE ALERT: registered device '%s' was re-quarantined (%s).",
                    device.get("name"), hold_reason
                )
            else:
                # Write only what moved. A birth is repeated, and an unconditional UPDATE would fire per
                # rebirth per device: the audit trigger suppresses the audit row for an identical write but
                # not the PostgREST round trip, the WAL record or the Realtime broadcast (`devices` is
                # REPLICA IDENTITY FULL). first_dbirth_at is write-once; the gate COALESCEs against the
                # stored value, so a stale cache entry cannot move it.
                desired = {"status": "ONLINE", "identity_source": device["_identity_source"]}
                update_fields = {
                    field: value
                    for field, value in desired.items()
                    if device.get(field) != value
                }
                if not device.get("first_dbirth_at"):
                    update_fields["first_dbirth_at"] = datetime.now(timezone.utc).isoformat()

                if update_fields:
                    # NULL means "leave alone" in the gate, which is what lets write-only-what-moved
                    # survive a fixed signature.
                    supabase_client.rpc("ingest_set_device_state", {
                        "p_device_id": device["id"],
                        "p_status": update_fields.get("status"),
                        "p_identity_source": update_fields.get("identity_source"),
                        "p_first_dbirth_at": update_fields.get("first_dbirth_at"),
                    }).execute()
                    # Updated in place so the next birth inside CACHE_TTL_SECONDS sees the new
                    # state and does not re-detect the same change. resolve_device() caches this
                    # exact dict, which is what makes the mutation visible to the next lookup.
                    device.update(update_fields)
                    count("device_state_writes")
                    logger.info(
                        "DBIRTH: device '%s' (%s) state changed -> %s",
                        device.get("name"), wire_id,
                        ", ".join(f"{k}={v}" for k, v in sorted(update_fields.items()))
                    )
                else:
                    count("device_state_writes_skipped")
                    logger.info(
                        "DBIRTH: verified registered device '%s' (%s); no state change",
                        device.get("name"), wire_id
                    )

        # Both run for quarantined devices too: they record what the device *claims*, which is
        # exactly what an administrator needs to inspect before approving it. DDATA telemetry
        # stays gated.
        store_birth_parameters(device["sparkplug_id"], payload)
        record_declared_metrics(device, payload)

        # A birth is evidence of life, quarantined or not, so the watchdog counts it.
        mark_device_seen(device)
    except DirectoryUnavailable as e:
        # The directory went away part way through (after resolve_device() succeeded). Same counter
        # as the arm above: both lose a birth certificate; the log line says where.
        drop(
            "dbirth_directory_unavailable",
            "DIRECTORY UNAVAILABLE part way through DBIRTH for '%s' (%s). No device state was "
            "changed; the next birth certificate will complete it.", wire_id, e,
            device=wire_id,
        )
    except Exception as e:
        logger.error("Error checking/updating Supabase devices for DBIRTH: %s", e, exc_info=True)

def process_ddeath(wire_id: str, gateway_wire_id: str):
    """
    On Sparkplug B DDEATH: mark the registered device OFFLINE in Supabase.
    """
    logger.info("Processing DDEATH for device '%s' via edge node '%s'", wire_id, gateway_wire_id)
    if not supabase_client:
        logger.warning("Supabase client unavailable. Skipping DDEATH status update for '%s'", wire_id)
        return

    try:
        # Unfiltered, so the refusal below can say ARCHIVED rather than leaving the line under it
        # to report a retired machine as one this stack never knew.
        device = resolve_device(wire_id, include_archived=True)
    except DirectoryUnavailable as e:
        # A missed death is a delayed status, not lost telemetry: the watchdog corrects it after
        # DEVICE_OFFLINE_TIMEOUT_SECONDS. Its own counter so it is not summed with lost births.
        drop(
            "ddeath_directory_unavailable",
            "DIRECTORY UNAVAILABLE: dropping DDEATH for '%s' (%s). The watchdog will mark it "
            "OFFLINE if it stays silent.", wire_id, e,
            device=wire_id,
        )
        return

    if device is not None and device.get("is_archived"):
        # Nothing to update: an archived device's status is not maintained. Counted, because a
        # message was refused, and under the same reason as the other two paths -- the harm does
        # not differ by message kind here, and the log line says which kind it was.
        drop(
            "device_archived",
            "Dropping DDEATH for ARCHIVED device '%s' (%s); its status is not maintained.",
            wire_id, device.get("name"),
            emit_log=_throttled(
                _archived_device_warned, wire_id, ARCHIVED_DEVICE_WARN_INTERVAL_SECONDS),
            device=wire_id,
        )
        return

    if device is None:
        logger.warning("DDEATH received for unregistered device '%s'; nothing to update", wire_id)
        return

    try:
        # Same gate as the watchdog: a row already OFFLINE is not rewritten.
        supabase_client.rpc("ingest_mark_device_offline", {
            "p_device_id": device["id"],
        }).execute()
        # An explicit death certificate is the authoritative answer, so the watchdog stops
        # tracking this device rather than flipping it OFFLINE a second time later.
        forget_device_seen(device["id"])
    except Exception as e:
        logger.error("Error applying DDEATH status update for '%s': %s", wire_id, e, exc_info=True)

def accept_reported_status(reported: str, edge_node_id: str = None):
    """
    Whether a gateway's self-reported status may be written, or None if it may not.

    A gateway names its own operating states but not the platform's (RESERVED_GATEWAY_STATUSES).
    Returns the trimmed string or None, which the caller answers by keeping the message type's
    status.
    """
    if not isinstance(reported, str):
        return None

    candidate = reported.strip()
    if not candidate:
        return None

    if len(candidate) > MAX_GATEWAY_STATUS_LENGTH:
        if _throttled(_status_rejected_warned, edge_node_id or "", STATUS_REJECT_WARN_INTERVAL_SECONDS):
            logger.warning(
                "Edge node '%s' reported a %d-character status; the cap is %d. Keeping the status "
                "implied by the message type. Statuses are labels, not a data channel.",
                edge_node_id, len(candidate), MAX_GATEWAY_STATUS_LENGTH
            )
        return None

    # Compared upper-cased so `awaiting_birth` cannot walk past a check on `AWAITING_BIRTH`.
    if candidate.upper() in RESERVED_GATEWAY_STATUSES:
        if _throttled(_status_rejected_warned, edge_node_id or "", STATUS_REJECT_WARN_INTERVAL_SECONDS):
            logger.warning(
                "Edge node '%s' reported the RESERVED status '%s'. Refused: that value is written "
                "by the platform (enrolment lifecycle) or derived at read time, and a gateway "
                "asserting it would make itself look healthy after it stopped publishing.",
                edge_node_id, candidate
            )
        count("gateway_status_reserved_rejected")
        return None

    return candidate

# -----------------------------------------------------------------------------
# Appliance health, carried on the heartbeat that already exists
# -----------------------------------------------------------------------------
# Ordinary metrics on the node-level message the appliance already publishes every 30s.
# on_message() routes node-level topics here, so none of this reaches the historian: it is
# current state with no history. `Agent_Version` overwrites the column enrolment stamps, so an
# in-place upgrade is visible.
GATEWAY_HEALTH_METRICS = {
    # metric name           column                  kind
    "Uptime_s":            ("uptime_seconds",      "int"),
    "Load_1m":             ("load_1m",             "float"),
    "Mem_Available_Bytes": ("mem_available_bytes", "int"),
    "Disk_Free_Bytes":     ("disk_free_bytes",     "int"),
    "Cert_Expires_At":     ("cert_expires_at",     "epoch_ms"),
    "Agent_Version":       ("agent_version",       "text"),
    "Flow_Hash":           ("flow_hash",           "text"),
}

# A sha256 hex digest is 64 characters, which is the longest of these by design. Over-length is
# dropped rather than truncated, for the same reason a status is: a truncated flow hash matches
# nothing and would read as "this appliance is running something we never deployed".
MAX_GATEWAY_HEALTH_TEXT_LENGTH = 64

# Sanity bounds for `Cert_Expires_At`, in epoch milliseconds: 2000-01-01 to 2200-01-01.
# Not "in the future": an already-expired CA is exactly what this metric exists to surface.
CERT_EPOCH_MS_MIN = 946684800000
CERT_EPOCH_MS_MAX = 7258118400000

# Throttle for refused health metrics, keyed by edge node id. An appliance publishing a bad value
# publishes it on every heartbeat -- 119 an hour -- so the refusal has to be legible without being
# the whole log. Same arrangement as the refused-status throttle above.
_health_rejected_warned = {}
HEALTH_REJECT_WARN_INTERVAL_SECONDS = 300

def _numeric_metric_value(metric):
    """The metric's numeric value whichever Sparkplug field carries it, or None."""
    for field in ("int_value", "long_value", "float_value", "double_value"):
        if metric.HasField(field):
            return getattr(metric, field)
    return None

def extract_gateway_health(group_id, edge_node_id, payload):
    """
    The recognised health metrics in a node-level payload, as a column -> value dict.

    Validated here rather than by a CHECK constraint: these columns are written in the same
    UPDATE as `status` and `last_heartbeat`, so a constraint violation would stop a live gateway
    reporting ONLINE. A failing metric is dropped and counted; the rest still lands.

    Returns {} when nothing recognised is present.
    """
    health = {}
    for metric in payload.metrics:
        # Resolved, not read raw, for the same reason the status metric is: a node publishing
        # alias-optimised NDATA carries no name, and a raw `metric.name` test would silently see
        # an appliance as reporting nothing at all.
        name = resolve_metric_name(group_id, edge_node_id, metric)
        mapping = GATEWAY_HEALTH_METRICS.get(name)
        if not mapping:
            continue
        column, kind = mapping

        if kind == "text":
            if not metric.HasField("string_value"):
                _reject_health(edge_node_id, name, "not a string")
                continue
            candidate = metric.string_value.strip()
            if not candidate or len(candidate) > MAX_GATEWAY_HEALTH_TEXT_LENGTH:
                _reject_health(edge_node_id, name, "empty or over %d characters"
                               % MAX_GATEWAY_HEALTH_TEXT_LENGTH)
                continue
            health[column] = candidate
            continue

        raw = _numeric_metric_value(metric)
        if raw is None:
            _reject_health(edge_node_id, name, "carries no numeric value")
            continue
        try:
            number = float(raw)
        except (TypeError, ValueError):
            _reject_health(edge_node_id, name, "not a number")
            continue
        # NaN and the infinities are floats and would serialise into JSON the database refuses.
        if number != number or number in (float("inf"), float("-inf")):
            _reject_health(edge_node_id, name, "not finite")
            continue

        if kind == "epoch_ms":
            if not (CERT_EPOCH_MS_MIN <= number <= CERT_EPOCH_MS_MAX):
                _reject_health(edge_node_id, name, "outside any plausible certificate date")
                continue
            health[column] = datetime.fromtimestamp(number / 1000, timezone.utc).isoformat()
            continue

        # Uptime, load, memory and free space are all quantities that cannot be negative. A
        # negative one is a counter that wrapped or a parse that went wrong, and recording it
        # would put a number on a page that an operator would act on.
        if number < 0:
            _reject_health(edge_node_id, name, "negative")
            continue
        health[column] = int(number) if kind == "int" else number

    return health

# -----------------------------------------------------------------------------
# The same readings, as Prometheus gauges -- because the columns have no history
# -----------------------------------------------------------------------------
# The database columns hold the latest value only; the gauges answer "is it filling".
# Four of the seven: `agent_version`, `flow_hash` and `cert_expires_at` stay in the database
# because the metrics endpoint is unauthenticated (see metrics.py).
GATEWAY_HEALTH_GAUGES = {
    "uptime_seconds":      "acs_ingestion_gateway_uptime_seconds",
    "load_1m":             "acs_ingestion_gateway_load1",
    "mem_available_bytes": "acs_ingestion_gateway_mem_available_bytes",
    "disk_free_bytes":     "acs_ingestion_gateway_disk_free_bytes",
}

HEALTH_REPORTED_GAUGE = "acs_ingestion_gateway_health_reported_timestamp_seconds"

# Last-seen values per edge node. Written only after resolve_gateway() matched a registered
# gateway, so a forged edge node id cannot add an entry. An archived gateway's series lingers
# until restart; its reported-at timestamp says so.
_gateway_health_gauges = {}
_gateway_health_gauges_lock = threading.Lock()

def record_gateway_health_gauges(edge_node_id, health, at):
    """
    Merge one payload's readings into this edge node's gauge set.

    Merged, not replaced, so a partial payload does not zero the rest. The reported-at gauge moves
    whenever anything was recognised: a gauge holds its last value forever and says nothing about
    its own age.
    """
    exported = {metric: health[column]
                for column, metric in GATEWAY_HEALTH_GAUGES.items() if column in health}
    with _gateway_health_gauges_lock:
        entry = _gateway_health_gauges.setdefault(edge_node_id, {})
        entry.update(exported)
        entry[HEALTH_REPORTED_GAUGE] = at.timestamp()

def gateway_health_gauge_snapshot() -> dict:
    """A copy, safe to read while the paho callback thread is writing."""
    with _gateway_health_gauges_lock:
        return {node: dict(values) for node, values in _gateway_health_gauges.items()}

# -----------------------------------------------------------------------------
# The appliance clock, measured from the heartbeat that is already arriving
# -----------------------------------------------------------------------------
# Offset = payload.timestamp - receipt time, on every node-level message. TLS tolerates the
# skew this daemon does not: an appliance a few minutes fast connects fine and files every
# sample at a time that never happened, inside TELEMETRY_MAX_FUTURE_SECONDS where nothing
# counts it. Positive means the appliance is ahead of this server, the direction that corrupts
# soonest. Nothing is rejected as implausible: an appliance reporting 1970 is a board with no
# RTC after a power cut, the most likely instance of this fault.
GATEWAY_CLOCK_OFFSET_GAUGE = "acs_ingestion_gateway_clock_offset_seconds"
GATEWAY_CLOCK_MEASURED_GAUGE = "acs_ingestion_gateway_clock_measured_timestamp_seconds"

# Below TELEMETRY_MAX_FUTURE_SECONDS, so the warning arrives while telemetry is still accepted.
GATEWAY_CLOCK_OFFSET_WARN_SECONDS = 60

# Throttle for the skew warning, per edge node. Longer than the health and status throttles:
# a clock fault is not fixed between one beat and the next.
GATEWAY_CLOCK_WARN_INTERVAL_SECONDS = 900
_gateway_clock_warned = {}

# Last measured offset per edge node. Separate from the health gauges because it is recorded on
# every node-level message from every registered gateway, whether or not the appliance reports
# health. Same bound: written only after resolve_gateway() matched.
_gateway_clock_gauges = {}
_gateway_clock_gauges_lock = threading.Lock()

def record_gateway_clock_offset(edge_node_id, payload, at):
    """
    Measure one appliance's clock offset in seconds and keep it for the next scrape.

    NDEATH must not reach here (the caller excludes it): a Last Will is built at connect time,
    so its timestamp is an arbitrarily earlier moment. A payload with no usable timestamp is not
    measured; the JSON branch of parse_sparkplug_payload() substitutes receipt time when absent,
    which would read as a flawless clock.
    """
    raw = getattr(payload, "timestamp", 0)
    if not raw or raw <= 0:
        return

    # Seconds throughout, no datetime conversion: datetime.fromtimestamp() raises on the values a
    # genuinely wrong clock produces, and those are the readings worth having.
    offset = (raw / 1000.0) - at.timestamp()

    with _gateway_clock_gauges_lock:
        _gateway_clock_gauges[edge_node_id] = {
            GATEWAY_CLOCK_OFFSET_GAUGE: offset,
            GATEWAY_CLOCK_MEASURED_GAUGE: at.timestamp(),
        }

    if abs(offset) >= GATEWAY_CLOCK_OFFSET_WARN_SECONDS and _throttled(
        _gateway_clock_warned, edge_node_id or "", GATEWAY_CLOCK_WARN_INTERVAL_SECONDS
    ):
        logger.warning(
            "CLOCK SKEW: edge node '%s' is %.0fs %s this server, measured against the timestamp on "
            "its own heartbeat. Every device timestamp it sends is being filed %.0fs %s, silently, "
            "and cannot be correlated with any other appliance. Nothing on the platform corrects "
            "this -- device timestamps are trusted for ordering. Fix time synchronisation on the "
            "appliance; telemetry is discarded outright beyond +%ds / -%ds.",
            edge_node_id, abs(offset), "ahead of" if offset > 0 else "behind",
            abs(offset), "early" if offset > 0 else "late",
            TELEMETRY_MAX_FUTURE_SECONDS, TELEMETRY_MAX_AGE_SECONDS,
        )

def gateway_clock_gauge_snapshot() -> dict:
    """A copy, safe to read while the paho callback thread is writing."""
    with _gateway_clock_gauges_lock:
        return {node: dict(values) for node, values in _gateway_clock_gauges.items()}

def _reject_health(edge_node_id, metric_name, reason):
    """Drop one health metric, loudly enough to find and quietly enough to live with."""
    count("gateway_health_metrics_rejected")
    if _throttled(_health_rejected_warned, edge_node_id or "", HEALTH_REJECT_WARN_INTERVAL_SECONDS):
        logger.warning(
            "Edge node '%s' reported an unusable health metric -- '%s': %s. Dropping that metric; "
            "the heartbeat and every other metric in the payload are unaffected.",
            edge_node_id, metric_name, reason
        )

def process_node_message(edge_node_id: str, msg_type: str, payload, group_id: str = None):
    """
    On Sparkplug B node-level messages (NBIRTH / NDATA / NDEATH): update the matching `gateways`
    row's status and last_heartbeat.

    NBIRTH/NDATA mark the edge node ONLINE; NDEATH marks it OFFLINE. A `Gateway_Status` metric
    overrides the derived status, subject to accept_reported_status(). Gateways are never
    auto-created.
    """
    # An NBIRTH resets the edge node's whole alias table -- including its devices' -- because it
    # invalidates every binding the node previously declared. Registered before the client check
    # and before gateway resolution, for the same reason as in process_dbirth.
    if msg_type == "NBIRTH":
        register_birth_aliases(group_id, edge_node_id, payload, reset=True)

    if not supabase_client:
        logger.warning("Supabase client unavailable. Dropping %s heartbeat for edge node '%s'", msg_type, edge_node_id)
        return

    status = "OFFLINE" if msg_type == "NDEATH" else "ONLINE"
    for metric in payload.metrics:
        # Resolved, not read raw: NDATA is a DATA message and may carry its status metric by
        # alias alone, in which case a raw `metric.name` test never matches and the gateway's
        # own reported status is silently replaced by the one inferred from the message type.
        name = resolve_metric_name(group_id, edge_node_id, metric)
        if name in ("Gateway_Status", "Node_Status") and metric.HasField("string_value"):
            # BREAK EITHER WAY. A refused claim is still the node's answer to "what is your
            # status" -- looking for a second, more acceptable one further down the payload
            # would let a gateway smuggle a reserved value past this by sending two.
            accepted = accept_reported_status(metric.string_value, edge_node_id)
            if accepted is not None:
                status = accepted
            break

    # Receipt time, not the payload timestamp: staleness is judged against this server's
    # clock, and edge node clocks drift (or, for a replayed payload, are plain wrong).
    heartbeat_dt = datetime.now(timezone.utc)

    try:
        gateway = resolve_gateway(edge_node_id, group_id)
    except DirectoryUnavailable as e:
        # Throttled on the same key as the unregistered-node warning: a heartbeat arrives every 30s.
        # The counter is outside the throttle, or the metric would report one drop per window.
        drop(
            "node_message_directory_unavailable",
            "DIRECTORY UNAVAILABLE: dropping %s from edge node '%s' (%s). This is NOT the "
            "unregistered-node path -- nothing is written and the next heartbeat retries.",
            msg_type, edge_node_id, e,
            emit_log=_throttled(_unknown_gateway_warned, edge_node_id, UNKNOWN_GATEWAY_WARN_INTERVAL_SECONDS),
            edge_node=edge_node_id, msg_type=msg_type,
        )
        return

    if gateway is None:
        # Rate-limited: an unregistered node beats every 30s and would otherwise
        # fill the log with the same line forever.
        if _throttled(_unknown_gateway_warned, edge_node_id, UNKNOWN_GATEWAY_WARN_INTERVAL_SECONDS):
            logger.warning(
                "Received %s from unregistered edge node '%s'. Register a gateway in the dashboard "
                "and configure this node to publish the sparkplug_id it is issued.",
                msg_type, edge_node_id
            )
        return

    # Not skippable: `public.gateway_status` derives staleness from `last_heartbeat` at read time,
    # so suppressing this write would make a live gateway read STALE. The audit trigger subtracts
    # the columns a heartbeat writes (audit_telemetry_columns(), 0100) before comparing, so a
    # heartbeat records no digital_thread row; a changed Flow_Hash is the exception, which the gate
    # records itself as a FLOW_DEPLOYED row. The comparison below only decides the log level.
    previous_status = gateway.get("status")
    transitioned = previous_status is not None and previous_status != status

    # NDEATH excluded here, beside the msg_type the rest of this function branches on; see
    # record_gateway_clock_offset(). After the registration check, before health because this does
    # not depend on the appliance reporting anything.
    if msg_type != "NDEATH":
        record_gateway_clock_offset(edge_node_id, payload, heartbeat_dt)

    # After the registration check: an unregistered node is dropped either way, and validating its
    # metrics first would log rejections for nothing. `health_reported_at` is stamped by the gate,
    # only when the health object is non-empty, so NULL means "does not report health".
    health = extract_gateway_health(group_id, edge_node_id, payload)
    if health:
        # The scrapeable half, for the readings that need a trend rather than a current value.
        record_gateway_health_gauges(edge_node_id, health, heartbeat_dt)

    try:
        # RESERVED_GATEWAY_STATUSES is enforced by the gate as well as by accept_reported_status()
        # above. The filter here saves a rejected round trip; the gate is what makes the rule hold
        # for anything holding this credential. See 0047.
        supabase_client.rpc("ingest_record_gateway_health", {
            "p_gateway_id": gateway["id"],
            "p_status": status,
            "p_heartbeat_at": heartbeat_dt.isoformat(),
            "p_health": health or None,
        }).execute()

        # Kept in step with the row resolve_gateway() cached, so the next heartbeat inside
        # CACHE_TTL_SECONDS compares against what was actually written rather than re-reporting
        # the same transition.
        gateway["status"] = status

        count("gateway_heartbeats")
        if transitioned:
            count("gateway_status_transitions")
            logger.info(
                "HEARTBEAT: %s from edge node '%s' (%s) -> STATUS TRANSITION %s -> %s at %s",
                msg_type, gateway.get("name"), edge_node_id,
                previous_status, status, heartbeat_dt.isoformat()
            )
        else:
            logger.info(
                "HEARTBEAT: %s from edge node '%s' (%s) -> status=%s at %s",
                msg_type, gateway.get("name"), edge_node_id, status, heartbeat_dt.isoformat()
            )
    except Exception as e:
        logger.error("Error updating gateway heartbeat for '%s': %s", edge_node_id, e, exc_info=True)

# -----------------------------------------------------------------------------
# Payload conformance -- what the device sent against what its schema allows
# -----------------------------------------------------------------------------
# Under the default `audit` policy nothing is dropped: the historian records what was observed
# and conformance is judged at read time against a schema an engineer can edit afterwards. What
# this adds is one SCHEMA_REJECTION row in the digital thread per change in the set of faults.
# Metrics the loop skipped (unresolved alias, timestamp outside the window) are included with
# `dropped: true`, since those are genuinely lost.
# See ingestion/README.md -> "Schema Conformance".

# device_uuid -> ModelledSchema (or None -- see device_modelled_constraints). Keyed on a resolved
# uuid, so it is bounded by the fleet; it gets the same container as the other caches anyway.
_schema_cache = TTLCache(MAX_ENTITIES_PER_CACHE, SCHEMA_CACHE_TTL_SECONDS, "schema")

def device_modelled_constraints(device_uuid: str):
    """
    The cached ModelledSchema for a device, or None when it has no schema attached at all.

    None and an empty map are different answers: None means nothing is bound and conformance is
    not evaluated; an empty map means a schema is bound and models no metrics.
    """
    # `(hit, value)` rather than a default, because None is a real answer here -- "no schema is
    # bound" -- and is exactly what the paragraph above distinguishes from an empty map.
    hit, cached = _schema_cache.get(device_uuid)
    if hit:
        return cached

    if not supabase_client:
        return None

    try:
        links = supabase_client.table("device_schemas").select("schema_id").eq(
            "device_id", device_uuid
        ).execute()
        ids = [row["schema_id"] for row in (links.data or []) if row.get("schema_id")]

        if not ids:
            result = None
        else:
            rows = supabase_client.table("schemas").select(
                "id,schema_definition"
            ).in_("id", ids).execute()
            result = modelled_constraints([r.get("schema_definition") for r in (rows.data or [])])
    except Exception as e:
        # NOT CACHED, and returned as None so no violation is reported. A directory blip must not
        # be able to write an audit row accusing a device of publishing something unmodelled --
        # that row is permanent, and the accusation would be an artefact of our own outage.
        logger.warning(
            "Could not read schemas for device %s (%s); conformance not evaluated for this "
            "message.", device_uuid, e
        )
        return None

    _schema_cache.set(device_uuid, result)
    return result

# {device_uuid: signature}. In-memory, so a daemon restart re-reports each distinct fault once --
# which is the right trade: an operator who restarts ingestion to clear a fault wants to know
# whether it came back.
_last_violation_signature = {}

def record_payload_violations(device: dict, violations, observed_at):
    """
    Write one SCHEMA_REJECTION row to the digital thread, only when the fault is new.

    DDATA arrives continuously and the table is append-only with no application role able to
    prune it, so a row per non-conforming message would fill the disk. Written when the set of
    (metric, code) pairs changes, never otherwise.
    """
    if not AUDIT_PAYLOAD_REJECTIONS or not supabase_client or not device:
        return

    device_id = device.get("id")
    if not device_id:
        return

    signature = violation_signature(violations)

    if not violations:
        # Recovery clears the memo, so a fault that returns after being fixed is recorded again.
        _last_violation_signature.pop(device_id, None)
        return

    if _last_violation_signature.get(device_id) == signature:
        count("payload_violations_suppressed", len(violations))
        return

    try:
        supabase_client.rpc("record_ingestion_rejection", {
            "p_device_id": device_id,
            "p_violations": violations,
            "p_observed_at": observed_at.isoformat(),
        }).execute()

        # Recorded only after the write SUCCEEDS. Marking it first would mean a transient PostgREST
        # failure silently swallowed the fault until its signature happened to change -- the same
        # trap test_audit_write_dedup.py already covers on the DBIRTH path.
        _last_violation_signature[device_id] = signature
        count("payload_violations_recorded", len(violations))

        logger.warning(
            "SCHEMA REJECTION: device '%s' -- %d violation(s): %s",
            device.get("name") or device_id,
            len(violations),
            ", ".join(sorted({"%s (%s)" % (v.get("metric") or "?", v["code"]) for v in violations}))
        )
    except Exception as e:
        count("payload_violation_write_failures")
        logger.error(
            "Could not record payload violations for '%s': %s", device.get("name"), e, exc_info=True
        )

# -----------------------------------------------------------------------------
# The historian writer
# -----------------------------------------------------------------------------
# One thread owns the TimescaleDB connection. The paho callback thread decides what a DDATA means
# and hands the rows over; this thread writes whatever has accumulated as one transaction. Under
# light traffic that is one message per transaction. Under load the queue fills while a commit is
# in flight and the next transaction carries everything that arrived meanwhile, so the fixed cost
# of a transaction is paid once per batch rather than once per message.
# See ingestion/README.md -> "The historian writer".

class PendingWrite(NamedTuple):
    """One DDATA, decided on the callback thread and waiting to be written."""
    wire_id: str
    device: dict
    asset_id: str
    asset_name: str
    rows: list
    observed: list
    dropped: list
    modelled: object
    payload_dt: datetime
    group_id: str
    client: object

def _write_batch(cur, batch):
    """The statements for one transaction: the asset rows, then every telemetry row."""
    # Asset rows first, for the foreign key. One statement, one row per asset: an upsert cannot
    # touch the same row twice in a statement, so the last name seen for an asset wins. Refreshed
    # on every write so a rename is not left stale.
    assets = {}
    for item in batch:
        assets[item.asset_id] = item.asset_name
    execute_values(
        cur,
        """
        INSERT INTO assets (asset_id, asset_name) VALUES %s
        ON CONFLICT (asset_id) DO UPDATE SET asset_name = EXCLUDED.asset_name
        """,
        list(assets.items()),
    )

    # DO NOTHING, not DO UPDATE: the historian is append-only, and an upsert would let any
    # publisher rewrite history. A duplicate is a redelivered MQTT message. Guarded on a non-empty
    # list: execute_values with no rows emits an invalid statement, and a batch whose every
    # metric was filtered is ordinary.
    rows = [row for item in batch for row in item.rows]
    if rows:
        execute_values(
            cur,
            """
            INSERT INTO telemetry (time, asset_id, metric_name, val_double, val_string, val_bool)
            VALUES %s
            ON CONFLICT (time, asset_id, metric_name) DO NOTHING
            """,
            rows,
            page_size=TELEMETRY_INSERT_PAGE_SIZE,
        )

def _after_commit(item):
    """What one message owes once its rows are durable."""
    count("metrics_written", len(item.rows))
    # Not `messages_written`: registry.count() reads every `messages_<x>` flat name as a message
    # type, and this is a count of commits, not of arrivals.
    count("written_messages")

    # After the commit, so the UNS carries only what the historian recorded. Off by default,
    # never raises, and timed into its own histogram (uns_publish.py).
    uns_publish.publish_ddata(
        item.client, supabase_client, item.device, item.group_id, item.rows,
        count=count, observe=observe_uns_seconds,
    )

    # Conformance, after the commit: this writes to Supabase over PostgREST, and a rejection row
    # asserts something about the device, which a rolled-back batch cannot support. `modelled`
    # was resolved before the write and is reused rather than re-read.
    if AUDIT_PAYLOAD_REJECTIONS:
        record_payload_violations(
            item.device,
            payload_violations(item.observed, item.dropped, item.modelled),
            item.payload_dt,
        )

class TelemetryWriter:
    """
    The queue between the callback thread and the historian, and the thread that drains it.

    `submit()` is the callback thread's side. `flush()` writes everything queued on the calling
    thread and exists for the suites, which never start the thread.
    """

    def __init__(self, maxsize, max_batch):
        self._queue = queue.Queue(maxsize)
        self.max_batch = max_batch
        self._stop = threading.Event()
        self._thread = None

    def depth(self):
        """Messages waiting. The saturation signal: it only grows while the writer is behind."""
        return self._queue.qsize()

    def submit(self, pending):
        """Queue one message. False when the queue stayed full for the whole put timeout."""
        try:
            self._queue.put(pending, timeout=TELEMETRY_QUEUE_PUT_TIMEOUT_SECONDS)
            return True
        except queue.Full:
            drop(
                "write_queue_full",
                "Historian writer queue has held %d messages for %.0fs; dropping DDATA for '%s'. "
                "The writer is slower than the fleet: read acs_ingestion_write_seconds.",
                TELEMETRY_QUEUE_MAX_MESSAGES, TELEMETRY_QUEUE_PUT_TIMEOUT_SECONDS, pending.wire_id,
                device=pending.wire_id,
            )
            return False

    def flush(self):
        """Write everything queued, now, on this thread. Not while the writer thread runs."""
        while True:
            batch = self._take(block=False)
            if not batch:
                return
            self._write(batch)

    def start(self):
        self._thread = threading.Thread(target=self._run, name="historian-writer", daemon=True)
        self._thread.start()

    def stop(self, timeout):
        """Ask the thread to drain what is queued and exit. True when it did within `timeout`."""
        self._stop.set()
        if self._thread is None:
            return True
        self._thread.join(timeout)
        return not self._thread.is_alive()

    def _run(self):
        while True:
            batch = self._take(block=True)
            if batch:
                try:
                    self._write(batch)
                except Exception:  # noqa: BLE001 - the writer thread must outlive any one batch
                    count("write_failures", len(batch))
                    logger.error(
                        "Historian writer: unhandled error; %d message(s) lost.", len(batch),
                        exc_info=True,
                    )
            elif self._stop.is_set():
                return

    def _take(self, block):
        """Whatever is queued, up to max_batch. Waits for the first item only when `block`."""
        items = []
        try:
            items.append(self._queue.get(block=block, timeout=0.5 if block else None))
        except queue.Empty:
            return items
        while len(items) < self.max_batch:
            try:
                items.append(self._queue.get_nowait())
            except queue.Empty:
                break
        return items

    def _write(self, batch):
        # The clock starts before the connection is acquired: a reconnect occupies this thread
        # for up to DB_CONNECT_MAX_ATTEMPTS * DB_CONNECT_BACKOFF_SECONDS, and that stall is what
        # the histogram exists to expose.
        started = time.perf_counter()

        db_conn = get_timescaledb_connection()
        if not db_conn:
            for item in batch:
                drop(
                    "db_unavailable",
                    "TimescaleDB connection unavailable. Skipping DDATA telemetry ingestion for '%s'",
                    item.wire_id,
                    device=item.wire_id,
                )
            return

        try:
            with db_conn:
                with db_conn.cursor() as cur:
                    _write_batch(cur, batch)
        except Exception as e:
            if len(batch) > 1:
                # One message can poison a batch. Retried one at a time, so only that message is
                # lost and write_failures counts it alone.
                count("write_batch_failures")
                logger.warning(
                    "Historian write of %d message(s) failed (%s); retrying each on its own.",
                    len(batch), e,
                )
                for item in batch:
                    self._write([item])
                return
            # The message is lost: `with db_conn` rolled the transaction back. Counted so the
            # loss is visible in STATS rather than only in the log.
            count("write_failures")
            logger.error("Error writing DDATA telemetry to TimescaleDB: %s", e, exc_info=True)
            return

        # After `with db_conn` exits: the commit is where a hypertable write becomes durable.
        observe_write_seconds(time.perf_counter() - started)
        for item in batch:
            _after_commit(item)

_writer = TelemetryWriter(TELEMETRY_QUEUE_MAX_MESSAGES, TELEMETRY_BATCH_MAX_MESSAGES)

def _drain_and_exit(signum, frame):
    """SIGTERM and SIGINT: say this host is going, write what was accepted, then exit."""
    # FIRST, while the broker connection is still up. A gateway that reacts to the host going away
    # should hear it at the start of the shutdown, not after a drain that may take
    # TELEMETRY_SHUTDOWN_DRAIN_SECONDS; and a clean DISCONNECT makes the broker discard the will,
    # so this publish is the only thing that will ever say it.
    if _primary_host_client is not None and _primary_host_timestamp_ms is not None:
        primary_host.announce_offline(_primary_host_client, _primary_host_timestamp_ms)

    queued = _writer.depth()
    logger.info("Signal %d: draining %d queued historian write(s) before exit.", signum, queued)
    if not _writer.stop(TELEMETRY_SHUTDOWN_DRAIN_SECONDS):
        logger.warning(
            "Historian writer did not drain within %.0fs; %d message(s) lost.",
            TELEMETRY_SHUTDOWN_DRAIN_SECONDS, _writer.depth(),
        )
    logging.shutdown()
    os._exit(0)

def process_ddata(wire_id: str, gateway_wire_id: str, payload, group_id: str = None, client=None):
    """
    On Sparkplug B DDATA: verify device registration, quarantine status and gateway binding. If
    quarantined, missing, or announced by a gateway the device is not bound to, drop the message.
    Otherwise insert the metrics into the TimescaleDB telemetry hypertable, keyed by the device's
    `sparkplug_id`.

    Metric names are resolved through the edge node's alias table. A metric whose alias is unknown
    is skipped and a rebirth is requested for the node.
    """
    try:
        # Unfiltered, so the archived refusal below is counted once and under its own reason
        # rather than arriving here as None and being reported as unregistered.
        device = resolve_device(wire_id, include_archived=True)
    except DirectoryUnavailable as e:
        # Telemetry fails closed: an unattributable row is not written. Nothing is written about the
        # device either; the stream resumes on its own.
        drop(
            "directory_unavailable",
            "DIRECTORY UNAVAILABLE: dropping DDATA for '%s' (%s). Not quarantined; the stream "
            "resumes when the directory returns.", wire_id, e,
            device=wire_id,
        )
        return

    # BEFORE the quarantine check, and the case this refusal exists for: a device is archived
    # while the gateway publishing for it stays in service, so nothing upstream stops its
    # readings. Without this they go on filling the historian under an asset every page filters
    # out -- and the row is keyed by sparkplug_id in a database that holds no `devices` table to
    # tell anyone it was retired.
    if device is not None and device.get("is_archived"):
        drop(
            "device_archived",
            "Dropping DDATA for ARCHIVED device '%s' (%s) on edge node '%s'. Restore it on the "
            "Archived Entities page to record its readings again.",
            wire_id, device.get("name"), gateway_wire_id,
            emit_log=_throttled(
                _archived_device_warned, wire_id, ARCHIVED_DEVICE_WARN_INTERVAL_SECONDS),
            device=wire_id,
        )
        return

    if device is None or device.get("is_quarantined"):
        drop(
            "quarantined_or_unregistered",
            "Dropping DDATA for quarantined/unregistered device '%s'", wire_id,
            device=wire_id,
        )
        return

    # Dropped rather than quarantined: a DDATA carries no birth certificate to inspect, and letting
    # an unbound publisher quarantine a healthy device would be a denial of service. The DBIRTH
    # path raises the alarm.
    try:
        binding_fault = verify_gateway_binding(device, gateway_wire_id, group_id)
    except DirectoryUnavailable as e:
        # The binding could not be CHECKED, so the row must not be written -- an unverifiable
        # attribution is exactly what this check exists to refuse. Dropped, not quarantined, for
        # the reason stated above: a DDATA stream must never be able to quarantine a device.
        drop(
            "directory_unavailable",
            "DIRECTORY UNAVAILABLE: cannot verify gateway binding for '%s' (%s); dropping DDATA "
            "rather than attributing it unverified.", wire_id, e,
            device=wire_id, edge_node=gateway_wire_id,
        )
        return

    if binding_fault:
        drop(
            "gateway_binding",
            "Dropping DDATA for device '%s' published via edge node '%s': %s",
            wire_id, gateway_wire_id, binding_fault,
            device=wire_id, edge_node=gateway_wire_id,
        )
        return

    # After the binding check, not before: a message from a publisher we have just refused to
    # believe is not evidence that the real device is alive.
    mark_device_seen(device)

    asset_id = device["sparkplug_id"]
    asset_name = device.get("name") or asset_id

    payload_ts = payload.timestamp if hasattr(payload, 'timestamp') and payload.timestamp > 0 else int(time.time() * 1000)
    payload_dt = datetime.fromtimestamp(payload_ts / 1000.0, timezone.utc)

    # For the conformance record, which the writer writes after the commit.
    observed = []
    dropped = []

    # Resolved before the write because enforcement decides drops as rows are built. Skipped
    # entirely when neither consumer wants it: device_modelled_constraints() can issue a PostgREST
    # round trip on a cache miss.
    enforcing = bool(device) and device.get("conformance_policy") == CONFORMANCE_ENFORCE
    modelled = (
        device_modelled_constraints(device["id"])
        if device and (enforcing or AUDIT_PAYLOAD_REJECTIONS)
        else None
    )
    # A device set to enforce whose schema could not be read is not enforced against: None means
    # "nothing is bound" or "the directory blinked", and neither is grounds for discarding a reading.
    enforcing = enforcing and modelled is not None
    rejected_schema = 0

    # Every metric decided here; nothing is written here. Failure granularity is per message:
    # the writer's transaction rolls a message back whole.
    rows = []
    rejected_timestamps = 0
    unresolved_aliases = 0
    for metric in payload.metrics:
        # `observed` and `dropped` are filled alongside the loop's own decisions, never by a second
        # pass that could disagree with what was written.
        # The alias is resolved before every other test, including the identity-metric filter: an
        # aliased Asset_ID has an empty name and would otherwise be written as a metric.
        metric_name = resolve_metric_name(group_id, gateway_wire_id, metric)
        if metric_name is None:
            unresolved_aliases += 1
            # NO NAME, and that is the whole condition being reported -- the metric
            # arrived as an alias no birth certificate explains. The alias number is
            # the only identity it has, so it is what the record carries.
            dropped.append((
                None,
                "unresolved_alias",
                "alias %s is not in edge node '%s' alias table" % (
                    getattr(metric, "alias", None), gateway_wire_id
                ),
            ))
            continue

        if metric_name in IDENTITY_METRICS:
            continue

        if metric.HasField('timestamp') and metric.timestamp > 0:
            metric_dt = datetime.fromtimestamp(metric.timestamp / 1000.0, timezone.utc)
        else:
            metric_dt = payload_dt

        # Reject rather than clamp: clamping relabels a reading to a time it did not happen, and
        # piles every sample from a broken clock onto one timestamp.
        if not _timestamp_is_sane(metric_dt):
            rejected_timestamps += 1
            dropped.append((
                metric_name,
                "timestamp_out_of_window",
                "timestamp %s is outside the sanity window (-%ds/+%ds)" % (
                    metric_dt.isoformat(),
                    TELEMETRY_MAX_AGE_SECONDS,
                    TELEMETRY_MAX_FUTURE_SECONDS,
                ),
            ))
            continue

        val_double = None
        val_string = None
        val_bool = None

        # Which of the three columns the value lands in is what a JSON Schema `type` constrains, so the
        # conformance check reads this rather than re-inspecting the protobuf.
        value_kind = None

        if metric.HasField("int_value"):
            val_double = float(metric.int_value)
            value_kind = "double"
        elif metric.HasField("long_value"):
            val_double = float(metric.long_value)
            value_kind = "double"
        elif metric.HasField("float_value"):
            val_double = float(metric.float_value)
            value_kind = "double"
        elif metric.HasField("double_value"):
            val_double = metric.double_value
            value_kind = "double"
        elif metric.HasField("boolean_value"):
            val_bool = metric.boolean_value
            value_kind = "bool"
        elif metric.HasField("string_value"):
            val_string = metric.string_value
            value_kind = "string"
        else:
            # A metric carrying no recognised value field is a genuine loss and is recorded.
            dropped.append((
                metric_name,
                "no_value",
                "metric carries no recognised Sparkplug value field",
            ))
            continue

        # The VALUE travels with the kind now: enum, minimum, maximum and pattern
        # are constraints on values, and the kind alone answered only `type`.
        metric_value = (
            val_double if value_kind == "double"
            else val_string if value_kind == "string"
            else val_bool
        )

        # ---------------------------------------------------------------------
        # Enforcement. Only reached for a device explicitly set to `enforce`.
        # ---------------------------------------------------------------------
        # The offending metric only, not the message, as for an unresolved alias or an out-of-window
        # timestamp above.
        if enforcing:
            constraint = modelled.metrics.get(metric_name)
            if constraint is None:
                faults = ([("unmodelled_metric",
                            "no attached schema declares this metric", {})]
                          if modelled.closed else [])
            else:
                faults = constraint_violations(
                    metric_name, value_kind, metric_value, constraint)
                faults = [
                    f for f in faults
                    if enforceable_violation({"code": f[0], "dropped": False},
                                             modelled.closed)
                ]

            if faults:
                code, detail, _extra = faults[0]
                dropped.append((metric_name, code, detail))
                rejected_schema += 1
                # Names the device, the metric and the constraint: the schema cache TTL means an edit starts
                # discarding telemetry up to five minutes later, and the line is what connects the two.
                logger.warning(
                    "SCHEMA ENFORCED: dropped metric '%s' for device '%s' (%s) -- %s "
                    "(%s). The device is set to conformance_policy=enforce; this "
                    "reading was NOT written and cannot be recovered.",
                    metric_name, device.get("name"), asset_id, code, detail
                )
                continue

        observed.append((metric_name, value_kind, metric_value))

        rows.append(
            (metric_dt, asset_id, metric_name, val_double, val_string, val_bool)
        )

    # Counted beside the warnings that name them. What was written is counted by the writer,
    # after the commit.
    count("metrics_rejected_timestamp", rejected_timestamps)
    # The same event labelled by edge node, which is what makes it actionable; this is the series
    # that is exported. `metrics_rejected_timestamp` stays beside its warning and reads back under
    # that flat name in the STATS line, summed from this series rather than exported twice
    # (metrics.py, EXPORTED_LABELLED_INSTEAD).
    count_labelled(
        "acs_ingestion_timestamps_rejected_total",
        {"edge_node": gateway_wire_id}, rejected_timestamps
    )
    count("metrics_unresolved_alias", unresolved_aliases)
    count("metrics_rejected_schema", rejected_schema)

    if unresolved_aliases:
        # Skip the undecodable metrics, keep the rest, and ask the node to re-birth. On a cold start
        # every metric is alias-only and nothing resolves, so the two are the same there.
        requested = request_node_rebirth(client, group_id, gateway_wire_id)
        if requested:
            logger.warning(
                "Dropped %d metric(s) for asset '%s': their aliases are not in edge "
                "node '%s' alias table, so no birth certificate has been seen for it "
                "since this daemon started. A rebirth has been requested.",
                unresolved_aliases, asset_id, gateway_wire_id
            )

    if rejected_timestamps:
        logger.warning(
            "Rejected %d metric(s) for asset '%s' with timestamps outside the sanity "
            "window (-%ds/+%ds). Check the gateway's clock.",
            rejected_timestamps, asset_id,
            TELEMETRY_MAX_AGE_SECONDS, TELEMETRY_MAX_FUTURE_SECONDS
        )

    if rejected_schema:
        # A second line, at the same level as the timestamp and alias summaries above,
        # so the per-message total is visible to somebody reading the log for volume
        # rather than for a specific metric.
        logger.warning(
            "Dropped %d metric(s) for asset '%s' that contradicted its bound schema. "
            "Set conformance_policy='audit' on this device to record without "
            "discarding.", rejected_schema, asset_id
        )

    _writer.submit(PendingWrite(
        wire_id=wire_id, device=device, asset_id=asset_id, asset_name=asset_name, rows=rows,
        observed=observed, dropped=dropped, modelled=modelled, payload_dt=payload_dt,
        group_id=group_id or DEFAULT_SPARKPLUG_GROUP, client=client,
    ))

# Whether the daemon is subscribed. `acs_ingestion_db_connected` answers the same question for
# PostgreSQL; "the process is running" and "the daemon is receiving messages" are different
# states, and CI waits on this one. Set after `subscribe()` returns, not after `connect()`.
# See docs/incidents.md -> "CI waited for a message count on a stack with no publisher".
_mqtt_subscribed = False

# The timestamp the primary host's death certificate was registered with, and the client to
# publish its birth and death on. Set in main() before connect(); read by on_connect and by the
# signal handler, neither of which is passed them. None means the will was never registered, which
# main() does not allow -- primary_host.state_topic() raises there first.
_primary_host_timestamp_ms = None
_primary_host_client = None

def on_connect(client, userdata, flags, rc, properties=None):
    """
    Subscribe once the broker has accepted the connection.

    `properties` is the MQTT 5 signature and is optional so the function is callable under either
    protocol. `rc` is a `ReasonCodes` under v5; `== 0` works because ReasonCodes.__eq__ compares
    against int (verified against the pinned paho 1.6.1).
    """
    global _mqtt_subscribed
    if rc == 0:
        logger.info("Connected to MQTT Broker successfully.")
        client.subscribe("spBv1.0/#")
        _mqtt_subscribed = True
        logger.info("Subscribed to 'spBv1.0/#'")
        # AFTER the subscribe, not before: the birth certificate says this host is consuming, and
        # until the subscription is in place it is not. Re-published on every reconnect because a
        # retained message survives the session that wrote it but the daemon's absence in between
        # was real -- the will said so, and this is what withdraws it.
        if _primary_host_timestamp_ms is not None:
            primary_host.announce_online(client, _primary_host_timestamp_ms)
    else:
        _mqtt_subscribed = False
        logger.error("Failed to connect to MQTT Broker, return code %s", rc)

def on_disconnect(client, userdata, rc, properties=None):
    """
    Log that the connection ended, with the broker's reason when the library delivers one.

    On the pinned paho 1.6.1 it does not for the common case: a v5 DISCONNECT carrying a reason
    code with empty properties is shorter than the length paho checks for, so the reason is
    discarded and this callback sees MQTT_ERR_CONN_LOST instead. The ReasonCodes branch below is
    for a newer paho or a broker that sends properties.
    See docs/incidents.md -> "paho 1.6.1 discards the broker's DISCONNECT reason".

    A log line, not a decision: loop_forever() reconnects on its own. rc == 0 is a disconnect this
    daemon asked for.
    """
    # Cleared for every disconnect, including the deliberate one: the subscription does not survive
    # the connection. Sits above the `rc == 0` return for that reason; on_connect sets it again.
    global _mqtt_subscribed
    _mqtt_subscribed = False

    if rc == 0:
        return

    # A ReasonCodes means the broker said why (a DISCONNECT packet). A bare int means paho said
    # why and the broker said nothing: 7 is MQTT_ERR_CONN_LOST, the socket went away.
    if isinstance(rc, int):
        logger.warning(
            "Disconnected from MQTT Broker: the connection dropped (paho rc=%s); the broker sent "
            "no reason. Reconnecting.", rc
        )
    else:
        logger.warning(
            "Disconnected from MQTT Broker by the broker: %s (reason code %s). Reconnecting. "
            "Under MQTT 3.1.1 this line could only have said 'unexpected'.", rc, int(rc.value)
        )

def parse_sparkplug_payload(msg):
    """
    Decode a Sparkplug B payload, falling back to the JSON encoding used by the Node-RED
    simulator flow. Returns None if the payload cannot be decoded.
    """
    payload = sparkplug_b_pb2.Payload()
    try:
        payload.ParseFromString(msg.payload)
        return payload
    except Exception as pb_err:
        try:
            import json
            data = json.loads(msg.payload.decode('utf-8'))
            if 'timestamp' in data:
                payload.timestamp = int(data['timestamp'])
            else:
                payload.timestamp = int(time.time() * 1000)

            # The Factory+ payload marker. Carried through so the fallback parser presents the
            # same payload shape the protobuf path does; nothing branches on it, because the
            # TOPIC is what identifies the asset and a self-declared marker is not evidence.
            if data.get('uuid'):
                payload.uuid = str(data['uuid'])

            # `seq` is carried through so the JSON fallback is not exempt from gap detection. Assigned
            # only when present and integral: defaulting a missing seq to 0 would read as a wrap.
            if isinstance(data.get('seq'), (int, float)) and not isinstance(data.get('seq'), bool):
                payload.seq = int(data['seq']) % 256

            for m in data.get('metrics', []):
                metric = payload.metrics.add()
                metric.name = m.get('name', '')
                # Carried through so the fallback is not silently alias-blind. Assigning the field
                # is what makes HasField('alias') true, which is what resolve_metric_name() tests.
                if m.get('alias') is not None:
                    metric.alias = int(m['alias'])
                if 'string_value' in m and m['string_value'] is not None:
                    metric.string_value = str(m['string_value'])
                if 'double_value' in m and m['double_value'] is not None:
                    metric.double_value = float(m['double_value'])
                if 'boolean_value' in m and m['boolean_value'] is not None:
                    metric.boolean_value = bool(m['boolean_value'])
                if 'int_value' in m and m['int_value'] is not None:
                    metric.int_value = int(m['int_value'])
                if 'datatype' in m and m['datatype'] is not None:
                    metric.datatype = int(m['datatype'])
            return payload
        except Exception:
            logger.warning("Failed to decode Sparkplug B payload on topic %s: %s", msg.topic, pb_err)
            return None

def extract_claimed_asset_id(payload):
    """The device's own Asset_ID claim, if it published one. Absent from aliased DDATA."""
    for metric in payload.metrics:
        if metric.name == 'Asset_ID':
            if metric.HasField('string_value'):
                return metric.string_value
            if metric.HasField('int_value'):
                return str(metric.int_value)
            if metric.HasField('long_value'):
                return str(metric.long_value)
            return None
    return None

def resolve_wire_identity(parts, payload):
    """
    Determine which device a message is about, and whether its identity is trustworthy.

    Returns (wire_id, quarantine_reason). wire_id is None if the message carries no usable
    identity at all.

    The topic is authoritative; the Asset_ID metric is a cross-check, absent from alias-encoded
    DDATA. The strict contract applies only to devices publishing a platform-issued id; a legacy
    device keeps "payload metric wins" so gateways can be reconfigured one at a time.
    See ingestion/README.md -> "Asset Identity on the Wire".
    """
    topic_id = parts[4] if len(parts) >= 5 else None
    claimed_id = extract_claimed_asset_id(payload)

    if not topic_id:
        # Pre-0014 flows that put identity solely in the payload metric.
        return claimed_id, None

    if DEVICE_ID_PATTERN.match(topic_id):
        if claimed_id and claimed_id != topic_id:
            logger.warning(
                "IDENTITY MISMATCH: topic says device '%s' but the Asset_ID metric claims '%s'. "
                "Trusting the topic and quarantining.", topic_id, claimed_id
            )
            return topic_id, "%s: topic device id '%s' contradicts the Asset_ID metric '%s'" % (
                REASON_IDENTITY_MISMATCH, topic_id, claimed_id
            )
        return topic_id, None

    detail = diagnose_device_identity(topic_id)
    if detail:
        return topic_id, "%s: %s" % (REASON_MALFORMED_IDENTITY, detail)

    # A legacy name in the topic. Preserve the historical precedence during the window.
    if claimed_id and claimed_id != topic_id:
        return claimed_id, None
    return topic_id, None

def on_message(client, userdata, msg):
    parts = msg.topic.split('/')
    if len(parts) < 4 or parts[0] != 'spBv1.0':
        return

    # The Sparkplug Group ID, used to scope the alias table and to address a rebirth request.
    group_id = parts[1]
    msg_type = parts[2]
    edge_node_id = parts[3]

    if not msg.payload:
        return

    payload = parse_sparkplug_payload(msg)
    if payload is None:
        return

    # An NCMD we published ourselves comes straight back on the wildcard subscription. Ignoring
    # command topics outright keeps a rebirth request from being read as edge-node traffic.
    if msg_type in ("NCMD", "DCMD"):
        return

    # A capture in flight takes a copy of what the daemon is about to ingest. Placed after the
    # checks above so a capture records what was acted on, and command topics stay out of capture
    # files. A no-op and one global read when nothing is recording.
    capture_worker.observe(msg.topic, msg.payload, parts)

    # Counted AFTER the parse and the command-topic filter, so this is messages the daemon
    # actually acted on rather than everything the wildcard subscription delivered.
    count("messages_total")
    count(f"messages_{msg_type.lower()}")

    # Follow the edge node's sequence counter before dispatching. Advisory: a gap is reported
    # and a rebirth requested, but the message itself is still processed -- it is a real
    # observation, and discarding it would compound the loss it is evidence of.
    check_message_sequence(group_id, edge_node_id, msg_type, payload, client=client)

    # Node-level topics (spBv1.0/<group>/<NBIRTH|NDATA|NDEATH>/<edge_node>) carry no
    # device component and no Asset_ID metric -- they are edge gateway heartbeats.
    if msg_type in NODE_MESSAGE_TYPES and len(parts) < 5:
        process_node_message(edge_node_id, msg_type, payload, group_id=group_id)
        return

    wire_id, quarantine_reason = resolve_wire_identity(parts, payload)
    if not wire_id:
        return

    if msg_type in ("DBIRTH", "NBIRTH"):
        process_dbirth(wire_id, edge_node_id, payload, quarantine_reason, group_id=group_id)
    elif msg_type == "DDATA":
        if quarantine_reason:
            # Faulty identity: the birth path is what records it for the operator. Telemetry
            # from an asset we cannot reliably identify must not reach the historian.
            logger.warning("Dropping DDATA from device '%s': %s", wire_id, quarantine_reason)
            return
        process_ddata(wire_id, edge_node_id, payload, group_id=group_id, client=client)
    elif msg_type == "DDEATH":
        process_ddeath(wire_id, edge_node_id)
    else:
        logger.info("Received %s message for device '%s' via edge node '%s'", msg_type, wire_id, edge_node_id)

REBIRTH_POLL_INTERVAL_SECONDS = int(os.getenv("REBIRTH_POLL_INTERVAL_SECONDS", "5"))

def start_rebirth_poller(client):
    """
    Send the rebirth requests a person asked for from the dashboard.

    A browser cannot publish MQTT and `write spBv1.0/+/NCMD/+` is granted to this principal alone,
    so a request is a row and this is what notices it. It sends exactly what
    request_node_rebirth() already sends, with `force=True` for the same reason capture uses it:
    the database permits one pending request per gateway.

    A daemon thread, forgiving of its own errors.
    """
    def poll():
        while True:
            time.sleep(REBIRTH_POLL_INTERVAL_SECONDS)
            if supabase_client is None:
                continue
            try:
                claimed = supabase_client.rpc("ingest_claim_rebirth_requests", {}).execute().data
            except Exception as e:
                logger.warning("Could not ask for rebirth requests: %s", e)
                continue

            for row in claimed or []:
                edge_node = row.get("edge_node_id")
                group = row.get("sparkplug_group")
                error = None
                sent = False
                try:
                    sent = request_node_rebirth(client, group, edge_node, force=True)
                    if not sent:
                        # `force=True` only returns False when the publish itself failed -- the
                        # throttle is bypassed -- so this is a broker problem, not a rate limit.
                        error = ("the rebirth request could not be published; the broker refused it "
                                 "or the connection was down")
                except Exception as e:
                    error = str(e)

                if error:
                    logger.warning("Rebirth request for '%s' failed: %s", edge_node, error)
                else:
                    logger.info("Rebirth requested for '%s' by an operator.", edge_node)

                try:
                    supabase_client.rpc("ingest_record_rebirth_outcome", {
                        "p_id": row.get("id"),
                        "p_throttled": False,
                        "p_error": error,
                    }).execute()
                except Exception as e:
                    # The row is already SENT from the claim, so nothing repeats. What is lost is
                    # the error text, which is worth one line rather than a retry loop.
                    logger.warning("Could not record the rebirth outcome for '%s': %s", edge_node, e)

    threading.Thread(target=poll, name="rebirth-poller", daemon=True).start()
    logger.info(
        "Rebirth request poller running: checking every %ds for requests from the dashboard.",
        REBIRTH_POLL_INTERVAL_SECONDS,
    )

def _require_credentials():
    """
    Refuse to start without the broker and database credentials. A missing secret must be a
    startup failure, not a silent downgrade to a published default.
    """
    missing = []
    if not MQTT_PASSWORD:
        missing.append("MQTT_PASSWORD")
    # TIMESCALEDB_URL carries its own credentials, so DB_PASSWORD is only required when the
    # connection is assembled from the discrete settings.
    if not TIMESCALEDB_URL and not DB_PASSWORD:
        missing.append("DB_PASSWORD")

    if missing:
        logger.critical(
            "CRITICAL CONFIGURATION ERROR: %s not set. The ingestion daemon no longer falls back "
            "to built-in default credentials -- a published default is a silent security "
            "downgrade. Set them in the environment and restart.",
            ", ".join(missing)
        )
        raise SystemExit(1)

def configure_mqtt_tls(client):
    """
    Put the MQTT client on TLS when MQTT_TLS_ENABLED is set. No-op otherwise.

    Verification is always on. A CA file that is set but missing raises here rather than falling
    back to the system store, which cannot verify an internal CA and would fail later with an
    error naming neither the variable nor the path.
    """
    if not MQTT_TLS_ENABLED:
        return False

    if MQTT_TLS_CA_FILE and not os.path.isfile(MQTT_TLS_CA_FILE):
        logger.critical(
            "CRITICAL CONFIGURATION ERROR: MQTT_TLS_ENABLED is set and MQTT_TLS_CA_FILE=%s does not "
            "exist. Refusing to start: falling back to the system trust store cannot verify an "
            "internal CA, so the daemon would fail at the TLS handshake with an error naming neither "
            "this setting nor the file.",
            MQTT_TLS_CA_FILE,
        )
        raise SystemExit(1)

    client.tls_set(
        # None means "use the system trust store", which is correct for a publicly-trusted broker
        # certificate and wrong for the internal CA this stack ships. Hence the check above.
        ca_certs=MQTT_TLS_CA_FILE or None,
        cert_reqs=ssl.CERT_REQUIRED,
        tls_version=ssl.PROTOCOL_TLS_CLIENT,
    )
    # Hostname checking is what makes the certificate mean anything. Set explicitly because
    # `tls_insecure_set(True)` is the one line that would silently undo this function.
    client.tls_insecure_set(False)
    logger.info(
        "MQTT TLS enabled; verifying the broker against %s",
        MQTT_TLS_CA_FILE or "the system trust store",
    )
    return True

def start_health_heartbeat(client):
    """
    Touch INGESTION_HEALTH_FILE every INGESTION_HEALTH_INTERVAL seconds while the MQTT connection
    is up. No-op when the variable is unset.

    A daemon thread, forgiving of write errors: a full filesystem should stop the heartbeat, not
    the daemon.
    """
    if not INGESTION_HEALTH_FILE:
        return

    def beat():
        while True:
            try:
                if client.is_connected():
                    with open(INGESTION_HEALTH_FILE, "w") as fh:
                        fh.write(str(int(time.time())))
            except Exception as exc:  # noqa: BLE001 - see docstring
                logger.warning("Could not write the health heartbeat: %s", exc)
            time.sleep(INGESTION_HEALTH_INTERVAL)

    threading.Thread(target=beat, name="health-heartbeat", daemon=True).start()
    logger.info(
        "Health heartbeat writing to %s every %ss",
        INGESTION_HEALTH_FILE,
        INGESTION_HEALTH_INTERVAL,
    )

def start_stats_reporter():
    """
    Log the throughput counters every INGESTION_STATS_INTERVAL seconds.

    Its own daemon thread, because start_health_heartbeat() returns immediately when
    INGESTION_HEALTH_FILE is unset. Both delta and total are reported; counters with zero delta
    and zero total are omitted, so a drop counter appearing at all is the signal.
    """
    if INGESTION_STATS_INTERVAL <= 0:
        logger.info("Throughput counter reporting is disabled (INGESTION_STATS_INTERVAL=0).")
        return

    def report():
        previous = {}
        while True:
            time.sleep(INGESTION_STATS_INTERVAL)
            try:
                current = counter_snapshot()
                parts = []
                for name in sorted(current):
                    total = current[name]
                    delta = total - previous.get(name, 0)
                    if total == 0:
                        continue
                    parts.append(f"{name}=+{delta}({total})")
                previous = current

                if parts:
                    logger.info("STATS (%ss): %s", INGESTION_STATS_INTERVAL, " ".join(parts))
                else:
                    # Said explicitly rather than skipped: silence from this reporter would be
                    # indistinguishable from the thread having died.
                    logger.info("STATS (%ss): no traffic", INGESTION_STATS_INTERVAL)
            except Exception as exc:  # noqa: BLE001 - a reporter must never stop ingestion
                logger.warning("Could not report throughput counters: %s", exc)

    threading.Thread(target=report, name="stats-reporter", daemon=True).start()
    logger.info("Throughput counters reporting every %ss", INGESTION_STATS_INTERVAL)

class _HealState:
    """
    What the startup healer still owes, carried between passes.

    A class rather than closure variables so that one pass is callable on its own from a test.
    """

    def __init__(self, check_privileges=False, reconcile_capture=False):
        self.privileges_checked = not check_privileges
        self.capture_reconciled = not reconcile_capture
        # Logged once per outage rather than once per attempt: a historian down for an hour is one
        # event, and 120 identical WARNING lines would bury the one that says it came back.
        self.reported_down = False

    @property
    def settled(self):
        """True when nothing deferred is outstanding. The loop keeps running anyway; see below."""
        return self.privileges_checked and self.capture_reconciled

def _heal_pass(state, supabase=None):
    """
    One iteration of the startup recovery loop. Mutates `state`; returns the usable connection.
    """
    global _ts_conn

    # Supabase first: reconciliation depends on neither the historian connection nor its outcome.
    if not state.capture_reconciled and supabase is not None:
        if capture_worker.reconcile(supabase):
            logger.info(
                "Capture reconciliation succeeded on retry; the sweep skipped at startup has now "
                "run, and captures are no longer blocked by a job a restart abandoned."
            )
            state.capture_reconciled = True

    conn = _ts_conn
    if conn is None or conn.closed != 0:
        # Connected with the lock released; see `_ts_conn_lock`. The callback thread may connect
        # first, which is resolved below by discarding this one.
        try:
            fresh = _connect_timescaledb(connect_timeout=DB_HEAL_CONNECT_TIMEOUT_SECONDS)
        except Exception as err:
            # NOT `db_connect_failures`. That counter means a message needed the historian and did
            # not get it, which is telemetry dropped -- and the alerting reads it that way. This
            # drops nothing: it is a daemon with no traffic waiting for a database.
            count("db_heal_failures")
            if not state.reported_down:
                logger.warning(
                    "Historian not reachable from the recovery loop: %s. Retrying every %.0fs. "
                    "Nothing is being dropped by this on its own -- a message arriving meanwhile "
                    "takes its own retry path.",
                    err, DB_HEAL_INTERVAL_SECONDS,
                )
                state.reported_down = True
            return None

        redundant = None
        with _ts_conn_lock:
            if _ts_conn is not None and _ts_conn.closed == 0:
                # The callback thread got there first, so its connection is the one in use and this
                # one is closed rather than leaked. Losing this race is the normal case on a busy
                # stack and is not worth a log line.
                redundant, conn = fresh, _ts_conn
            else:
                _ts_conn = conn = fresh
                count("db_heals")
                logger.info(
                    "Historian connection recovered by the startup recovery loop; "
                    "acs_ingestion_db_connected now reads 1."
                )
        if redundant is not None:
            redundant.close()

    state.reported_down = False

    # On the healed connection, because that is the connection whose privileges matter: it is the
    # check main() skipped when the startup connect failed.
    if not state.privileges_checked and conn is not None:
        try:
            _assert_historian_is_least_privilege(conn)
        except SystemExit:
            # A daemon thread swallows SystemExit, so the refusal has to reach the process via os._exit.
            # The assertion has already logged why.
            logging.shutdown()
            os._exit(1)
        state.privileges_checked = True

    return conn

def _heal_loop(state, supabase=None):
    """The sleep around _heal_pass(). Separate so that one pass can be tested without a thread."""
    while True:
        time.sleep(DB_HEAL_INTERVAL_SECONDS)
        try:
            _heal_pass(state, supabase)
        except Exception as exc:  # noqa: BLE001 - a recovery loop must never stop ingestion
            logger.warning("Startup recovery pass failed: %s", exc)

def start_startup_healer(supabase=None, check_privileges=False, reconcile_capture=False):
    """
    Retry, off the message path, the startup work a dependency that was not up yet prevented.

    A node coming back brings pods up in the kubelet's order, not the dependency graph's. Two
    startup steps depend on a database being up, with different
    dependencies: the historian connection (which `acs_ingestion_db_connected` reads) and
    capture_worker.reconcile() (Supabase). Each is retried until it succeeds.

    The thread stays resident afterwards so the gauge answers "can this daemon reach the
    historian" rather than "has a write succeeded since boot".
    See docs/incidents.md -> "Ingestion started before the historian and nothing retried".
    """
    threading.Thread(
        target=_heal_loop,
        args=(_HealState(check_privileges, reconcile_capture), supabase),
        name="startup-healer",
        daemon=True,
    ).start()
    logger.info(
        "Startup recovery loop running every %.0fs (historian connection%s%s).",
        DB_HEAL_INTERVAL_SECONDS,
        ", deferred privilege check" if check_privileges else "",
        ", deferred capture reconciliation" if reconcile_capture else "",
    )

def scrape_time_series():
    """
    The series read when a scrape arrives, as {(metric, ((label, value), ...)): value}.

    STATES, NOT EVENTS, which is the whole reason they are read here rather than incremented at a
    site. `db_connected` is the clearest case: `_ts_conn.closed` cannot see a server-side drop, so
    this answers "did the daemon believe it had a connection", and
    `acs_ingestion_db_connect_failures_total` rising while it reads 1 is exactly that drop.
    """
    series = {
        ("acs_ingestion_up", ()): 1,
        ("acs_ingestion_db_connected", ()):
            1 if (_ts_conn is not None and not _ts_conn.closed) else 0,
        # The subscription, not the connection. See the note above on_connect().
        ("acs_ingestion_mqtt_connected", ()): 1 if _mqtt_subscribed else 0,
        ("acs_ingestion_write_queue_depth", ()): _writer.depth(),
    }

    # Cache occupancy. The evictions counter is the one worth an alert: non-zero means
    # MAX_ENTITIES_PER_CACHE is being reached.
    for cache in (_device_cache, _gateway_cache, _schema_cache):
        series[("acs_ingestion_cache_entries", (("cache", cache.name),))] = len(cache)
        series[("acs_ingestion_cache_evictions_total", (("cache", cache.name),))] = cache.evictions

    # Appliance health. The reported-at timestamp says how old the readings are; a gauge holds its
    # last value indefinitely.
    for edge_node, values in gateway_health_gauge_snapshot().items():
        for metric, value in values.items():
            series[(metric, (("edge_node", edge_node),))] = value

    # The appliance clock, beside its measured-at gauge for the same reason.
    for edge_node, values in gateway_clock_gauge_snapshot().items():
        for metric, value in values.items():
            series[(metric, (("edge_node", edge_node),))] = value

    return series

def start_metrics_endpoint():
    """Serve the registry in Prometheus exposition format."""
    if INGESTION_METRICS_PORT <= 0:
        # The policy decision lives here rather than in metrics.py, where port 0 means "ask the OS
        # for a free one" as it does everywhere else in the socket API.
        logger.info("Metrics endpoint disabled (INGESTION_METRICS_PORT=%s).", INGESTION_METRICS_PORT)
        return None

    registry.set_scrape_time_source(scrape_time_series)
    start_metrics_server(INGESTION_METRICS_PORT, registry.render, logger)

def main():
    logger.info("Initializing Supabase + TimescaleDB Ingestion Daemon...")
    _require_credentials()

    # Before the MQTT loop, so a misconfigured credential is a startup failure. A historian that is
    # down is transient and survivable; one that refuses the credential is permanent, and retrying
    # would discard every reading while logging the same line per message.
    _startup_conn = None
    try:
        _startup_conn = _connect_timescaledb()
    except Exception as err:
        if _is_authentication_failure(err):
            logger.critical(
                "CRITICAL CONFIGURATION ERROR: the historian refused this daemon's credential "
                "(%s). This never resolves by retrying, and the daemon would otherwise run "
                "indefinitely discarding every reading. DB_USER is '%s' -- check that "
                "INGEST_WRITER_PASSWORD matches the role timescaledb/roles.sql created, and that "
                "INGEST_DB_USER and INGEST_DB_PASSWORD are set together if either is set.",
                str(err).strip().splitlines()[-1] if str(err).strip() else err, DB_USER,
            )
            raise SystemExit(1)
        logger.warning(
            "Could not reach the historian at startup, so its privileges were not checked: %s. "
            "This is treated as transient -- the per-message retry path covers a database that is "
            "merely down.", err
        )

    if _startup_conn is not None:
        _assert_historian_is_least_privilege(_startup_conn)
        # Kept, not closed: `acs_ingestion_db_connected` reads `_ts_conn`, and on a quiet stack
        # nothing else opens it, so a discarded startup connection left the gauge at 0 and fired
        # `Historian Unreachable From Ingestion` against a reachable historian. Same single writer,
        # opened earlier. This covers only the boot where the connect succeeds; start_startup_healer()
        # covers the other.
        global _ts_conn
        with _ts_conn_lock:
            _ts_conn = _startup_conn
    if supabase_client is None:
        logger.critical(
            "CRITICAL SECURITY ERROR: Supabase client is uninitialized! SUPABASE_URL, "
            "SUPABASE_PUBLISHABLE_KEY or SUPABASE_INGESTION_KEY missing or invalid. "
            "SUPABASE_INGESTION_KEY replaced SUPABASE_SERVICE_ROLE_KEY here (see Machine Identities in supabase/README.md); a "
            "values file predating that change has no such key -- npm run setup mints it "
            "(secrets.ingestionKey). "
            "Ingestion daemon refusing to start MQTT loop in fail-open state. System halting to enforce fail-closed device quarantine gating."
        )
        raise SystemExit(1)

    # MQTT 5 with paho-mqtt 1.6.1's v1 callback API; paho 2.x would force CallbackAPIVersion.
    # The daemon is on v5 because the platform is. The broker's DISCONNECT reason is discarded by
    # paho 1.6.1 before on_disconnect() sees it (see there).
    client = mqtt.Client(protocol=mqtt.MQTTv5)
    client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    # Before connect(), necessarily: paho applies the TLS context when the socket is opened.
    configure_mqtt_tls(client)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message

    # BEFORE connect() and before any background thread, so an unusable host id stops the daemon
    # while it is still doing nothing. paho applies the will when the CONNECT packet is built, so
    # this is also the last point at which registering one has any effect.
    #
    # REFUSING TO START IS THE POINT. The host id is what a third-party gateway is configured to
    # watch, so a daemon that ran without one would satisfy every health check while leaving the
    # topic those gateways watch permanently empty -- which is the state this was built to end.
    # The chart fails the render first (templates/apps/ingestion.yaml), so an operator normally
    # meets this at `helm upgrade` rather than here.
    global _primary_host_timestamp_ms, _primary_host_client
    try:
        _primary_host_timestamp_ms = primary_host.register_will(client)
        _primary_host_client = client
    except primary_host.PrimaryHostIdError as err:
        logger.critical("CRITICAL CONFIGURATION ERROR: %s", err)
        raise SystemExit(1)

    # Started before the connect loop, not after: the connect loop below retries indefinitely, so
    # a broker that never comes up would otherwise leave the heartbeat unstarted and the file
    # absent -- which a prober reads as "never became healthy", which is exactly right.
    start_health_heartbeat(client)
    # Safe to start here for the opposite reason: it sweeps only devices it has already seen, and
    # it has seen none until the broker connects.
    start_device_watchdog()
    # Also before the connect loop, so a daemon that cannot reach the broker still reports "no
    # traffic" on a timer rather than going silent in a way that looks like a crash.
    start_stats_reporter()
    # The writer before the broker connects: nothing drains the queue until it runs. The
    # directory refresher likewise, so the first messages resolve against a warm cache.
    _writer.start()
    start_directory_refresher()
    # A daemon stuck retrying the broker must still be scrapeable: `acs_ingestion_up` at 1 with
    # flat counters is what "connected to nothing" looks like, and is distinguishable from a dead
    # target.
    start_metrics_endpoint()
    # After the client exists, because a capture opens by asking its edge node to rebirth, and
    # before the connect loop so a daemon retrying the broker still sweeps abandoned jobs. The
    # rebirth function is passed in rather than imported: capture_worker is imported here, so the
    # reverse import would be a cycle.
    start_rebirth_poller(client)
    capture_reconciled = capture_worker.start(
        supabase_client,
        # force=True: see request_node_rebirth(). A capture is one button press, single-flight
        # across the stack, and worthless without the birth certificate it opens by asking for.
        rebirth=lambda group_id, edge_node_id: request_node_rebirth(
            client, group_id, edge_node_id, force=True),
    )

    # After the client exists, because it publishes. Off unless DIRECTORY_MQTT_ENABLED is set, and
    # it logs which. The Directory is derived from the enrolment records, not from the birth
    # stream: publishing a DBIRTH does not make an unenrolled device a resolvable address.
    directory_publish.start(client, supabase_client)
    # The UNS bridge publishes from the DDATA path itself and only needs to say which state it is
    # in; a bridge that is off and silent reads the same as one that is on and failing.
    uns_publish.announce()

    # Last of the background threads, because it needs the outcome of the steps above. On a clean
    # start both flags are False and this thread only keeps the historian gauge honest.
    start_startup_healer(
        supabase=supabase_client,
        check_privileges=_startup_conn is None,
        reconcile_capture=not capture_reconciled,
    )

    # On the main thread, where signal handlers must be installed.
    signal.signal(signal.SIGTERM, _drain_and_exit)
    signal.signal(signal.SIGINT, _drain_and_exit)

    while True:
        try:
            logger.info("Connecting to MQTT Broker at %s:%s...", MQTT_HOST, MQTT_PORT)
            # `clean_start=True` is v5's clean_session. No session expiry interval is set: Sparkplug's
            # NDEATH is the Last Will, and a surviving session would delay it.
            client.connect(MQTT_HOST, MQTT_PORT, 60, clean_start=True)
            break
        except Exception as e:
            logger.warning("MQTT Broker connection failed: %s. Retrying in 2 seconds...", e)
            time.sleep(2)

    client.loop_forever()

if __name__ == "__main__":
    main()
