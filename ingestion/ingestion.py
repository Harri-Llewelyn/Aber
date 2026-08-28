import os
import re
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
import metrics
from metrics import start_metrics_server

logger = get_logger("ingestion")

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
# TimescaleDB connection configuration
TIMESCALEDB_URL = os.getenv("TIMESCALEDB_URL")
DB_HOST = os.getenv("DB_HOST", "timescaledb")
DB_PORT = os.getenv("DB_PORT", "5433" if os.getenv("DB_HOST") is None else "5432")
DB_NAME = os.getenv("DB_NAME", "postgres")
DB_USER = os.getenv("DB_USER", "postgres")
# NO DEFAULT, deliberately. A published default ("postgres" / "acscymru123") means a
# deployment with the variable missing connects with a known-weak credential instead of
# failing -- the failure mode is silence, which is the worst one. These are validated in
# main(), matching how SUPABASE_SERVICE_ROLE_KEY has always been treated: refuse to start.
#
# Validation lives in main() rather than at import so the pure-logic unit suites, which
# import this module with a stubbed environment and never open a connection, keep working.
DB_PASSWORD = os.getenv("DB_PASSWORD")

# MQTT Broker configuration
MQTT_HOST = os.getenv("MQTT_HOST", "mosquitto")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
# The INGESTION principal, not a shared platform account. mosquitto.acl grants it `read
# spBv1.0/#` plus `write spBv1.0/+/NCMD/+` and nothing else, which is exactly what this daemon
# does: it is a consumer whose only publish() is the rebirth NCMD in request_rebirth().
MQTT_USER = os.getenv("MQTT_USER", "factoryplus_ingestion")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD")

# MQTTS. Opt-in, and it does NOT change how the daemon authenticates -- MQTT_USER/MQTT_PASSWORD
# above still identify it.
#
# With an internal CA the system trust store knows nothing about it, so an empty MQTT_TLS_CA_FILE
# makes verification fail outright. That is the correct failure, not a silent downgrade, and it is
# why there is deliberately NO "skip verification" setting: encryption without verification looks
# identical on the wire to a successful interception.
#
# Why it is off by default: ../ingestion/README.md -> "Configuration"
MQTT_TLS_ENABLED = os.getenv("MQTT_TLS_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")
MQTT_TLS_CA_FILE = os.getenv("MQTT_TLS_CA_FILE", "").strip()

# Supabase configuration
SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")

# TWO KEYS, DOING DIFFERENT JOBS, AND NEITHER IS THE SERVICE-ROLE KEY ANY MORE (see Machine Identities in supabase/README.md).
#
# The anon key is the `apikey` the gateway checks. Its Lua filter admits exactly two literal
# strings, so the ingestion token cannot be sent in its place -- it would be refused at the edge
# before PostgREST ever saw it.
#
# The ingestion token is the Authorization bearer and is what actually authorises the writes. It
# names Service_Ingestor (migration 0046), an `authenticated` principal holding Operator, which
# cannot write a single row directly: every write goes through a SECURITY DEFINER gate in 0047 that
# checks the caller is that principal. This is the same shape i3X uses -- pass a bearer through to
# PostgREST and let RLS answer -- rather than a key that bypasses RLS entirely.
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_INGESTION_KEY = os.getenv("SUPABASE_INGESTION_KEY", "")

# Liveness heartbeat. OPT-IN, empty by default: Docker Compose declares no healthcheck for this
# service and nothing reads the file there, so writing one would be litter. Kubernetes sets it and
# probes the file's age -- see deploy/helm/acs-cymru/templates/apps/ingestion.yaml.
#
# WHY A HEARTBEAT AND NOT A MESSAGE COUNTER. The obvious implementation touches the file in
# on_message, which reports the daemon dead every time the shopfloor is quiet -- nights, weekends,
# changeovers. This writes on a timer instead and gates on client.is_connected(), so the signal is
# "my broker connection is alive", which is the thing that actually breaks and the thing a restart
# actually fixes. paho's loop_forever() reconnects on its own, but it cannot recover from every
# state (a stale socket after a broker restart is the common one), and until now nothing noticed.
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

# Bound on each entity resolution cache -- the same reasoning as MAX_ALIASES_PER_NODE, applied to
# the caches that were missed when that one was written. They are keyed by the id observed ON THE
# WIRE, so they are fed by exactly the same untrusted source (issue #23).
#
# A TTL IS NOT A BOUND. Expiry is only checked on read, so an entry nobody reads again is never
# evicted no matter how stale it is -- a misconfigured gateway cycling ids, a fault loop, or an
# enumeration attempt against the broker grows the dict forever. The TTL makes entries stale; only
# a capacity limit makes them go away.
#
# 1000 is well above any plausible fleet and low enough to bound memory at a few megabytes. The
# broker ACL constrains the EDGE NODE segment of a topic but not the DEVICE segment, so this is
# defence in depth rather than the only thing standing in the way.
MAX_ENTITIES_PER_CACHE = int(os.getenv("MAX_ENTITIES_PER_CACHE", "1000"))

# A SHORTER TTL FOR NEGATIVE ENTRIES WAS CONSIDERED AND NOT TAKEN, because both arguments for it
# turn out to be answered elsewhere:
#
#   * Freshness. A device that gets registered should not stay "unregistered" for the full TTL --
#     but the write sites already handle that: the quarantine insert in process_dbirth() SETS the
#     cache entry to the new row, and the re-quarantine path POPS it. Nothing waits for expiry.
#   * Abuse. A negative entry is the one an unregistered publisher can create at will -- which is
#     an argument for expiring it more SLOWLY, not more quickly. Re-resolving sooner means more
#     PostgREST round trips during exactly the id flood the cap exists to absorb, so a shorter
#     negative TTL would trade a bounded memory problem for an unbounded directory-load one.

# Throughput counter reporting. Set to 0 to disable.
#
# SEPARATE FROM INGESTION_HEALTH_INTERVAL, and not folded into the liveness heartbeat, because
# that thread returns immediately when INGESTION_HEALTH_FILE is unset -- which is the Compose
# default. Counters reported from inside it would therefore never appear on the one target where
# they are most likely to be read by hand.
#
# THIS IS A LOG REPORTER, AND IT IS NOT THE METRICS ENDPOINT. It exists to establish a throughput
# baseline before the telemetry write path is batched, and to make a stalled daemon legible in
# `docker logs`. The Prometheus endpoint below reads the same registry -- which is what the note
# here predicted it would: "a new exporter over the same registry rather than a
# re-instrumentation". Both remain, because they answer different questions: this one is what
# somebody reads at 3am with no Prometheus to hand.
INGESTION_STATS_INTERVAL = int(os.getenv("INGESTION_STATS_INTERVAL", "60"))

# The Prometheus exposition endpoint (issues #22 and #24). 0 disables it.
#
# ITS OWN PORT, not a path on something that already listens, because the daemon listens for
# nothing else -- it is an MQTT client and a database writer. 9108 is in the unassigned exporter
# range and does not collide with the stack's published ports.
#
# NO CREDENTIAL, deliberately, and that decides what may appear on it: counters and nothing else.
# No metric values, no device names, no payloads. See ingestion/metrics.py.
INGESTION_METRICS_PORT = int(os.getenv("INGESTION_METRICS_PORT", "9108"))

# How many telemetry rows go into one INSERT statement. A DDATA message is written as a single
# batched statement; this caps how large that statement may get, so a pathological payload cannot
# build an unbounded query string. 500 is far above any real Sparkplug payload -- under
# report-by-exception a DDATA usually carries one metric -- so in practice every message is
# exactly one statement.
TELEMETRY_INSERT_PAGE_SIZE = int(os.getenv("TELEMETRY_INSERT_PAGE_SIZE", "500"))

# Bounded retry on a failed TimescaleDB connection.
#
# WHY THIS EXISTS. get_timescaledb_connection() previously returned None on the first failure, and
# every caller answers None by dropping the message with a warning -- so a database blip during a
# burst lost telemetry silently, visible only in a log line. A short backoff covers the common
# case (a restart, a brief network fault) without blocking the MQTT callback thread for long: the
# thread is shared by every device, so a long retry here stalls the whole fleet, which is why the
# ceiling is deliberately low rather than generous.
DB_CONNECT_MAX_ATTEMPTS = int(os.getenv("DB_CONNECT_MAX_ATTEMPTS", "3"))
DB_CONNECT_BACKOFF_SECONDS = float(os.getenv("DB_CONNECT_BACKOFF_SECONDS", "0.25"))
DB_CONNECT_BACKOFF_MAX_SECONDS = float(os.getenv("DB_CONNECT_BACKOFF_MAX_SECONDS", "2.0"))

# -----------------------------------------------------------------------------
# Payload conformance auditing
# -----------------------------------------------------------------------------
# ON BY DEFAULT, and switchable because it writes to an APPEND-ONLY table. Every other counter this
# daemon keeps can be reset by restarting it; a digital_thread row cannot be removed by any
# application role, by design. An operator commissioning a noisy new gateway needs a way to stop
# the record filling with the same finding while they fix it, and the honest way to offer that is a
# flag rather than a hope that the deduplication below is always enough.
AUDIT_PAYLOAD_REJECTIONS = os.getenv("AUDIT_PAYLOAD_REJECTIONS", "true").lower() == "true"

# How long a device's attached schemas are cached before being re-read.
#
# MUCH LONGER THAN CACHE_TTL_SECONDS (5s, for the device row), because the two answer different
# questions. The device row carries `status` and `is_quarantined`, which change under the daemon's
# own feet and must be near-live. A schema binding changes when an engineer edits it, which is a
# human-scale event -- so re-reading it per message would be one PostgREST round trip per DDATA to
# learn nothing, on the hottest path in the process.
#
# The cost of the staleness is bounded and worth stating: for up to this long after a schema edit,
# conformance is judged against the previous definition. It cannot cause a wrong DROP, because
# nothing is dropped for non-conformance -- see payload_violations().
SCHEMA_CACHE_TTL_SECONDS = int(os.getenv("SCHEMA_CACHE_TTL_SECONDS", "300"))

# -----------------------------------------------------------------------------
# Supabase Client Initialization
# -----------------------------------------------------------------------------
supabase_client = None
try:
    from supabase import create_client, Client
    if SUPABASE_URL and SUPABASE_ANON_KEY and SUPABASE_INGESTION_KEY:
        # Declares the daemon as the actor behind its writes, so digital_thread rows say
        # "ingestion" rather than the generic "service".
        #
        # A HEADER, because the daemon and the edge functions used to arrive on the SAME
        # service-role key -- the connection alone could not tell them apart. PostgREST exposes
        # request headers as the `request.headers` GUC, which log_digital_thread_event() reads.
        #
        # STILL NEEDED NOW THAT THE DAEMON HAS ITS OWN IDENTITY, and for a sharper reason than
        # before. The trigger concludes `actor_source = 'user'` from `auth.uid()` being non-NULL,
        # so a daemon with a real `sub` would have relabelled every ingestion write as a human
        # action -- the exact claim that function refuses to accept from a header. 0048 teaches it
        # that a machine principal is not a user; this header is what it falls back to reading.
        #
        # The trigger accepts only 'ingestion' / 'service' / 'migration' from this header and
        # never 'user': a client asserting a human author for its own writes is precisely the
        # claim it must not be able to make.
        #
        # Set on the PostgREST session rather than through ClientOptions(headers=...) -- that
        # constructor is incomplete in supabase-py 2.x and raises on an attribute the Auth client
        # then expects ("'ClientOptions' object has no attribute 'storage'"). Mutating the
        # session's headers is the path that actually reaches PostgREST, verified end to end.
        supabase_client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
        try:
            # `.auth()` AND NOT `session.headers["Authorization"] = ...`, which is the obvious
            # thing and does not work. Setting the session header appears to succeed -- read it
            # back and it is there -- but supabase-py re-derives Authorization from the client's
            # own token on every request, so the anon key goes out regardless and PostgREST
            # resolves the role as `anon`. That failure is quiet in the worst way: reads of
            # `devices` and `gateways` come back 42501 while the header says what you set.
            #
            # The apikey stays the anon key (create_client put it there), so the request carries
            # `apikey: <anon>` for the gateway's filter and `Bearer <ingestion token>` for
            # PostgREST -- which is what makes auth.uid() resolve to Service_Ingestor and opens
            # the 0047 gates.
            supabase_client.postgrest.auth(SUPABASE_INGESTION_KEY)
            supabase_client.postgrest.session.headers["X-ACS-Cymru-Actor"] = "ingestion"
        except Exception as header_err:
            # Losing the label is not worth losing ingestion over: without it the trigger falls
            # back to 'service', which is still attributed, just less specific.
            logger.warning(
                "Could not set the actor header (%s); audit rows will read 'service'.", header_err
            )
        logger.info("Supabase client initialized successfully.")
    else:
        logger.warning(
            "SUPABASE_URL, SUPABASE_ANON_KEY or SUPABASE_INGESTION_KEY missing. Supabase "
            "integration disabled. SUPABASE_INGESTION_KEY replaced SUPABASE_SERVICE_ROLE_KEY -- "
            "see Machine Identities in supabase/README.md; run scripts/setup.mjs or copy the key from .env.example."
        )
except Exception as e:
    logger.warning("Failed to initialize Supabase client: %s", e)

# -----------------------------------------------------------------------------
# TimescaleDB Connection Manager
# -----------------------------------------------------------------------------
_ts_conn = None


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

    MATCHED ON SQLSTATE FIRST, text second. psycopg2 surfaces the server's code as `pgcode` --
    28P01 is `invalid_password` and 28000 `invalid_authorization_specification` -- and those are
    the authority. The string check is the fallback for a driver-level failure that carries no
    code, and is kept narrow so a connection refused or a DNS failure is NOT caught here: those
    are transient, and treating them as fatal would make the daemon crash-loop through an ordinary
    database restart.
    """
    code = getattr(err, "pgcode", None)
    if code in ("28P01", "28000"):
        return True
    text = str(err).lower()
    return "password authentication failed" in text or "no password supplied" in text


def _connect_timescaledb():
    """
    One connection attempt, with the exception left to the caller.

    Separate from get_timescaledb_connection() because that function's contract is to absorb
    failures and return None -- which is right on the message path and useless at startup, where
    the DIFFERENCE between failures is the whole question.
    """
    if TIMESCALEDB_URL:
        return psycopg2.connect(TIMESCALEDB_URL)
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )


def _assert_historian_is_least_privilege(conn):
    """
    Refuse to run as a superuser on the historian.

    WHY THE DAEMON CHECKS THIS ITSELF rather than trusting configuration. Every other guarantee
    here is enforced where it can be observed: the broker ACL is asserted by delivery, the write
    gates by `is_ingestion_caller()`, the audit trail by a trigger. "Append-only historian writes"
    was the exception -- a claim in the README's security model that depended on nobody having
    changed DB_USER, and it was wrong for months without anything noticing.

    A grant can be widened, a compose file edited, a Helm value overridden. What cannot be argued
    with is asking the database, at startup, what this connection actually is.

    REFUSES RATHER THAN WARNS, because a warning in a startup log is exactly how the original
    problem survived. Recovery still has a door: ALLOW_HISTORIAN_SUPERUSER=true, which is a
    deliberate sentence someone has to write.

    SUPERUSER IS THE ONLY THING TESTED, not the full grant list. The precise grants are asserted by
    timescaledb/roles.sql's own self-check and by test_historian_role_grants.py, which run against
    the database rather than through this process. What this adds is the one property those cannot
    see: which role THIS connection actually holds.
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

    ONE CONNECTION, NOT A POOL. Every write happens on the paho callback thread, so there is
    exactly one writer and a pool would be complexity with no consumer. That property is also
    what makes the module-level global safe -- and it is the thing to revisit first if a worker
    thread is ever introduced, because psycopg2 connections are not safe for concurrent use.

    `closed` IS CHECKED BUT IS NOT SUFFICIENT. psycopg2 sets it only when the connection was
    closed on this side; a connection dropped by the server, a restart, or an idle timeout still
    reports `closed == 0` and fails on first use. The caller's exception handler is what covers
    that, and the next call through here re-opens.

    RETRIES ARE BOUNDED AND SHORT. Returning None on the first failure meant a momentary blip
    dropped telemetry silently, since every caller answers None by dropping the message. But this
    runs on the callback thread shared by the whole fleet, so a generous retry would stall every
    other device's messages behind one unreachable database. Three attempts over well under a
    second is the compromise: it absorbs a restart without becoming a stall.
    """
    global _ts_conn

    if _ts_conn is not None and _ts_conn.closed == 0:
        return _ts_conn

    if _ts_conn is not None:
        # Closed on this side. Say so rather than reconnecting silently -- a connection that keeps
        # having to be re-opened is a symptom worth seeing in the log.
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
                    "TimescaleDB connection failed after %d attempt(s): %s. Telemetry for this "
                    "message is dropped; the next message retries.",
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
# Assets are identified on the wire by an immutable, platform-issued id: a 3-character type
# prefix plus 21 lowercase hex characters, derived from the row's UUID primary key by the
# `sparkplug_id` generated column (migration 0014). Asset *names* are display labels only
# and can be edited freely without breaking ingestion, telemetry continuity, or the audit
# trail -- which was the entire point of moving off name-based identity.
GATEWAY_ID_PATTERN = re.compile(r"^gwy[0-9a-f]{21}$")
DEVICE_ID_PATTERN = re.compile(r"^dev[0-9a-f]{21}$")
SPARKPLUG_ID_LENGTH = 24

# An RFC4122 UUID as Factory+ publishes one in `Instance_UUID`. Matched case-insensitively
# because the standard does not fix the case and PostgREST compares uuid values, not text.
UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Payload metrics that carry identity rather than configuration or telemetry. Asset_ID is the
# device's own claim about which asset it is (used only as a cross-check against the topic);
# Asset_Name is a human-readable hint. Instance_UUID and Schema_UUID are the Factory+ birth
# profile -- which asset this is, and which model it conforms to.
#
# None is stored as a parameter, a telemetry sample, or a DECLARED METRIC. The last matters
# most: a schema models what a device measures, and an identity assertion is not a measurement.
# Counting them would flag every Factory+-conformant device as publishing two metrics its
# schema does not model.
IDENTITY_METRICS = ("Asset_ID", "Asset_Name", "Instance_UUID", "Schema_UUID")

# The Factory+ Sparkplug payload marker, carried in the payload's top-level `uuid` field. Read
# for logging only: the topic is still what identifies the asset.
FACTORYPLUS_PAYLOAD_UUID = "11ad7b32-1d32-4c4a-b0c9-fa049208939a"

# Default Sparkplug Group ID, matching gateways.sparkplug_group's column default (migration
# 0008). Used only to describe the fallback in a log line; resolution never assumes it.
DEFAULT_SPARKPLUG_GROUP = "ACS-Cymru"

class DirectoryUnavailable(Exception):
    """
    The device/gateway directory could not be REACHED. Distinct from "not registered".

    THESE WERE THE SAME VALUE UNTIL 2026-08. resolve_device() returned None both for a device
    Supabase does not know about and for a Supabase it could not talk to, and process_dbirth()
    reads None as "unregistered" -- a state it answers by WRITING A QUARANTINE ROW. So any
    transport fault during a birth certificate (Kong restarting, a PostgREST error, a dropped
    connection) would register a legitimate device as UNKNOWN_DEVICE.

    That is the wrong severity for a transient error, because quarantine is not a retry state. It
    persists in the database, it requires an operator to approve the device out of it
    (approve_quarantined_device), and until they do every DDATA the device sends is dropped. One
    unreachable moment would stop a real machine recording indefinitely, under a reason naming its
    identity -- the one thing that was never in question.

    "Fail closed" is right for TELEMETRY: an unverifiable row must not be written. It is wrong for
    a STATE CHANGE about the device itself. Raising here keeps the first behaviour and removes the
    second: callers drop the message, and the next one resolves normally.
    """


# Recorded on devices.quarantine_reason as "<CODE>: <detail>".
REASON_UNKNOWN_DEVICE = "UNKNOWN_DEVICE"
REASON_MALFORMED_IDENTITY = "MALFORMED_IDENTITY"
REASON_IDENTITY_MISMATCH = "IDENTITY_MISMATCH"
REASON_GATEWAY_MISMATCH = "GATEWAY_MISMATCH"

# Telemetry sanity window. A device supplies its own metric timestamps and they are trusted
# for ordering, but not unconditionally: a clock-skewed or hostile gateway would otherwise
# write rows arbitrarily far into the past or future, landing them outside the retention
# window or in a compressed chunk that rejects the write.
#
# Asymmetric on purpose. Late data is normal -- a gateway buffers through a network outage
# and flushes on reconnect -- so the backward tolerance is generous. Data from the future is
# never legitimate; it is always a clock fault, so the forward tolerance covers ordinary NTP
# skew and nothing more.
TELEMETRY_MAX_AGE_SECONDS = 24 * 60 * 60   # 24 hours behind now
TELEMETRY_MAX_FUTURE_SECONDS = 5 * 60      # 5 minutes ahead of now

# Recorded on devices.identity_source.
SOURCE_SPARKPLUG_ID = "sparkplug_id"
SOURCE_REPORTED_IDENTITY = "reported_identity"
SOURCE_INSTANCE_UUID = "instance_uuid"
SOURCE_LEGACY_NAME = "legacy_name"

# Statuses a gateway may NOT assert about itself, and the length cap on the ones it may.
#
# `gateways.status` is deliberately unconstrained text (migration 0025) because a `Gateway_Status`
# metric in an NBIRTH overrides whatever the message type implies -- the domain is the fleet's, not
# ours. That is a statement about VOCABULARY, not about authority, and the two were conflated: the
# payload string was written through verbatim, so a gateway could claim any value at any length.
#
# The three below are the platform's own, written by code that knows something the gateway does
# not. PENDING_ENROLLMENT and AWAITING_BIRTH are enrolment lifecycle, set by the issuing RPC and by
# enroll-gateway; STALE is DERIVED at read time by public.gateway_status and is never stored at
# all. All three short-circuit ahead of the staleness arm in that view, so a gateway asserting one
# renders itself permanently not-stale on the dashboard -- it would go on looking healthy after it
# stopped publishing, which is the one thing the derived status exists to prevent.
#
# REJECTED, NOT TRUNCATED OR REMAPPED. There is no legitimate reading of a gateway claiming to be
# awaiting its own birth, so the message type's own status is the honest answer and the claim is
# dropped with a warning.
RESERVED_GATEWAY_STATUSES = frozenset({"PENDING_ENROLLMENT", "AWAITING_BIRTH", "STALE"})

# Long enough for any status a fleet reasonably uses ("MAINTENANCE_SCHEDULED" is 21), short enough
# that the column cannot be used as storage. Over-length is refused rather than truncated: a
# truncated status is a DIFFERENT status, and silently inventing one is worse than keeping the
# status the message type already implies.
MAX_GATEWAY_STATUS_LENGTH = 32

CACHE_TTL_SECONDS = 5


class TTLCache:
    """
    A bounded, TTL'd, thread-safe LRU. Replaces the bare dicts these caches used to be (issue #23).

    TWO PROPERTIES ARE LOAD-BEARING AND BOTH ARE EASY TO BREAK BY ACCIDENT.

    1. `get` RETURNS THE STORED OBJECT, NEVER A COPY. resolve_device() caches a row dict and the
       DBIRTH path then mutates THAT DICT IN PLACE -- `device.update(update_fields)` in
       process_dbirth(), and `device["last_birth_metrics"] = declared` in
       record_declared_metrics() -- specifically so the next lookup inside the TTL sees the new
       state and does not re-detect the same change. A cache that returned copies would break that
       silently, and the symptom would not look like a cache bug: it would be a duplicate UPDATE
       and a duplicate digital_thread row on every rebirth, which is exactly what the write-only-
       what-moved work exists to prevent.

    2. `get` RETURNS `(hit, value)`, NOT A VALUE OR A DEFAULT. `None` is a legitimate cached value
       here -- it is the NEGATIVE entry, "this wire id resolved to nothing". A `get` returning None
       for both "absent" and "cached as unregistered" would conflate them, and the consequence is
       not a crash: negative caching would quietly stop working, and every message from an
       unregistered device would go back to the directory. `_schema_cache` has the same shape for
       its own reason -- see device_modelled_constraints() on why None and an empty map differ.

    EVICTION IS LRU AND THAT IS NOT AN ARBITRARY CHOICE. The entry a TTL cannot reach is by
    definition one nobody has read, and the least-recently-used entry is exactly that entry. So the
    capacity bound removes the stale ones first without needing a sweep to find them.
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

# Sparkplug B metric alias table, keyed by EDGE NODE -- (group_id, edge_node_id) -> {alias: name}.
#
# Sparkplug assigns each metric an integer alias in a birth certificate and thereafter publishes
# DATA carrying the alias alone, with no name. A daemon reading only `name` therefore ingests
# nothing at all from an alias-optimised gateway, and reports no error while doing it.
#
# PER NODE, NOT PER DEVICE: Sparkplug scopes alias uniqueness to the whole edge node including its
# devices, so a device's DDATA may legitimately carry an alias declared in that node's NBIRTH.
# Keying per device would silently miss those.
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

# `status` and `identity_source` ARE READ BACK DELIBERATELY, and not merely for display: the
# DBIRTH path compares them against what it is about to write and skips the write when nothing
# moved (see process_dbirth). Without them in the cached row every rebirth issues an UPDATE that
# changes nothing -- which costs a PostgREST round trip and, because `devices` is REPLICA IDENTITY
# FULL and in the supabase_realtime publication, broadcasts a full-row change event to every
# connected dashboard. The audit trigger already suppresses the *audit row* for such a write
# (migration 0005); it cannot suppress the write itself.
_DEVICE_COLUMNS = (
    "id,name,sparkplug_id,reported_identity,gateway_id,is_quarantined,first_dbirth_at,"
    "last_birth_metrics,status,identity_source,conformance_policy"
)

# The value of devices.conformance_policy that lets a violation DROP a metric rather than only
# record it (0050). Anything else -- including the 'audit' default and a row fetched before this
# column existed -- means record and write anyway, which is the behaviour since 0026.
CONFORMANCE_ENFORCE = "enforce"


# -----------------------------------------------------------------------------
# Throughput counters
# -----------------------------------------------------------------------------
# A plain dict behind a lock rather than a metrics library: the daemon has four dependencies and
# each one is justified in requirements.txt. Counters are monotonic and are never reset, so a
# reported delta is the traffic in that interval and the absolute is the traffic since start.
#
# INCREMENTED AT THE SITES THAT ALREADY DECIDE, not by wrapping them. Every `drop` reason below
# corresponds one-to-one with an existing logger.warning, so the counters and the log cannot
# disagree about what happened.
_counters = {}
_counters_lock = threading.Lock()


def count(name: str, n: int = 1):
    """Add to a monotonic counter. Unknown names are created on first use."""
    if n <= 0:
        return
    with _counters_lock:
        _counters[name] = _counters.get(name, 0) + n


def counter_snapshot() -> dict:
    """A copy of the counters, safe to read while the callback thread is writing."""
    with _counters_lock:
        return dict(_counters)


# LABELLED COUNTERS, kept beside the flat ones rather than replacing them.
#
# The flat registry is a name -> int dict, which cannot express "gaps, by edge node" without
# encoding the node into the name and making the STATS line unreadable. This holds the few series
# that genuinely need a dimension.
#
# CARDINALITY IS BOUNDED BY DESIGN. The only label in use is `edge_node`, which is one per gateway
# on the site. Labelling by DEVICE would be unbounded -- and `seq` is an edge-node-scoped counter
# anyway, so a device label would be describing the wrong thing.
_labelled = {}


def count_labelled(name: str, labels: dict, n: int = 1):
    """Add to a monotonic counter carrying labels. Key order is normalised so it cannot split."""
    if n <= 0:
        return
    key = (name, tuple(sorted(labels.items())))
    with _counters_lock:
        _labelled[key] = _labelled.get(key, 0) + n


def labelled_snapshot() -> dict:
    with _counters_lock:
        return dict(_labelled)


# ---------------------------------------------------------------------------------------------
# THE HISTORIAN WRITE LATENCY HISTOGRAM.
#
# WHY A DISTRIBUTION AND NOT A COUNTER. Every other series here answers "how many"; this one
# answers "how long", and the two cannot be the same shape. A mean would be actively misleading
# on this path -- the interesting write is the slow one that stalls every OTHER device behind it,
# and a mean is precisely the statistic that hides it.
#
# THIS IS THE MEASUREMENT THE SINGLE-WRITER CEILING IS ASSERTED WITHOUT. get_timescaledb_connection()
# states the ceiling in a docstring; nobody has ever measured it. Fitting the instrument BEFORE
# anything moves is the whole point -- a latency number taken after a rewrite has nothing to be
# compared against, which is the wrong way round from how the roadmap first put it.
#
# BUCKETS SPAN THE THREE REGIMES THIS PATH ACTUALLY HAS, rather than being copied from
# prometheus_client's defaults: sub-millisecond to a few milliseconds is a healthy local insert,
# tens to hundreds of milliseconds is contention or a saturated disk, and anything at or above
# 0.25s means the bounded reconnect in get_timescaledb_connection() ran -- DB_CONNECT_BACKOFF_SECONDS
# is 0.25 and DB_CONNECT_MAX_ATTEMPTS is 3, so the retry path lands in the top three buckets and
# nowhere else. That makes a reconnect stall READABLE OFF THE HISTOGRAM instead of inferable only
# by correlating with acs_ingestion_db_reconnects_total.
WRITE_SECONDS_BUCKETS = (
    0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
)

# COUNTS PER BUCKET, NOT CUMULATIVE. Prometheus wants cumulative `le` buckets and metrics.py
# accumulates them at render time, because this list is written on the callback thread and read
# once per scrape: one increment per observation is the right trade against thirteen.
_write_seconds_buckets = [0] * len(WRITE_SECONDS_BUCKETS)
_write_seconds_sum = 0.0
_write_seconds_count = 0


def observe_write_seconds(seconds: float):
    """
    Record one committed historian write.

    ONLY COMMITTED WRITES ARE OBSERVED, and that is a deliberate exclusion rather than an
    oversight. A write that raised has its own counter (`write_failures`), and its duration
    describes the failure -- a connection timing out -- not the daemon's capacity to keep up. Let
    the two share a histogram and a p99 spike stops being readable: it could mean a slow database
    or an absent one, which call for opposite responses.

    Shares _counters_lock rather than taking a second one: it is held for a handful of integer
    increments, and one lock cannot deadlock against itself.
    """
    global _write_seconds_sum, _write_seconds_count
    with _counters_lock:
        _write_seconds_count += 1
        _write_seconds_sum += seconds
        for i, upper in enumerate(WRITE_SECONDS_BUCKETS):
            if seconds <= upper:
                _write_seconds_buckets[i] += 1
                return
        # Above the last finite bucket. Nothing to increment -- +Inf is derived from the total at
        # render time, so an outlier is still counted in `_count` and still moves `_sum`.


def histogram_snapshot() -> dict:
    """Histogram state, in the shape metrics.render_exposition() takes."""
    with _counters_lock:
        return {
            "acs_ingestion_write_seconds": {
                "buckets": tuple(zip(WRITE_SECONDS_BUCKETS, _write_seconds_buckets)),
                "sum": _write_seconds_sum,
                "count": _write_seconds_count,
            }
        }


def diagnose_device_identity(wire_id: str):
    """
    Explain how `wire_id` fails the wire-identity contract, or return None if it is acceptable.

    A bare legacy name is deliberately *not* an error during the migration window -- only
    something that is evidently an attempt at a platform-issued id (right prefix, wrong shape)
    is. That distinction is what makes "the gateway truncated the id" a diagnosable condition
    rather than just another anonymous unknown device in the queue.
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

    `reset` clears the node's whole table first and is used for NBIRTH only: per Sparkplug an
    NBIRTH invalidates all prior state for that edge node *and its devices*, so a gateway that
    renumbers its aliases must not leave the old bindings behind to be matched against. A DBIRTH
    merges, because it re-declares one device's metrics and must not discard its siblings'.
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

    Returns None when the metric carries neither a name nor a resolvable alias -- which the caller
    must treat as "this node's birth has not been seen", not as "this metric is uninteresting".
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


def request_node_rebirth(client, group_id, edge_node_id):
    """
    Ask an edge node to republish its birth certificates. Returns True if a request was sent.

    THIS IS WHAT CLOSES THE ALIAS COLD START. The alias table is in-memory, so it is empty after
    every restart -- and a stable device may not birth again for weeks. Without a way to ask, an
    ingestion restart would silently stop recording every alias-optimised device until someone
    power-cycled the gateway.

    RATE LIMITED PER NODE, and that is the load-bearing part. A gateway that responds to a rebirth
    by restarting, or one that never responds at all, would otherwise be asked once per message.
    """
    if client is None or not edge_node_id:
        return False

    key = "%s/%s" % (group_id or "", edge_node_id)
    if not _throttled(_rebirth_requested, key, REBIRTH_REQUEST_INTERVAL_SECONDS):
        return False

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

    Returns True if the message arrived in sequence (or could not be judged), False if a gap
    was detected.

    WHY THIS MATTERS FAR MORE UNDER REPORT-BY-EXCEPTION. When a device published every metric
    on a timer, a dropped message cost one sample and the next tick five seconds later carried
    the same information again -- the loss self-healed and nothing downstream could tell. Under
    RBE a message IS the change: if the DDATA saying a machine went from ACTIVE to INTERRUPTED
    is the one that gets dropped, nothing ever restates it. The historian, the dashboard and
    every alert rule keep reporting ACTIVE indefinitely, and they are all confidently wrong.

    The sequence number is the only evidence available that this happened. A metric that stopped
    arriving is indistinguishable from a metric that stopped changing -- that ambiguity is
    inherent to RBE -- but `seq` skipping from 41 to 43 is unambiguous, and the response is the
    same one the alias cold start already uses: ask the node to re-birth, which re-declares every
    metric at its current value and repairs the divergence.

    NDEATH IS EXCLUDED. It is the broker's Last Will, registered at connect time and published
    when the node is already gone, so it carries bdSeq rather than a live `seq` and is not part
    of the counter's run.

    RESYNCS ON A GAP rather than staying latched to the value it expected. Holding the old
    expectation would make every subsequent message look out of sequence too, turning one drop
    into a permanent alarm -- and the rebirth this triggers is itself a message that advances
    the counter.
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

    # THE COUNTER IS THE WHOLE POINT OF ISSUE #24, and it changes nothing else here: the message is
    # still processed, the rebirth is still requested, the rate limit is still honoured. A gap is
    # evidence of loss, and discarding the message that carries the evidence would compound it.
    #
    # BOTH COUNTERS, because one gap of 200 and 200 gaps of 1 are different faults -- a single
    # broker reconnect against a gateway that is dropping messages continuously. The rate of the
    # first is what to alert on; the second is what says how much was lost.
    #
    # NEITHER LEGITIMATE NON-GAP REACHES HERE. The 255 -> 0 wrap is absorbed by `expected` being
    # modulo 256, and the first message after a restart returns above on `previous is None`. Both
    # are asserted in test_sequence_gap_metrics.py rather than re-checked here.
    count_labelled("acs_ingestion_sequence_gaps_total", {"edge_node": edge_node_id})
    count_labelled(
        "acs_ingestion_sequence_messages_missed_total", {"edge_node": edge_node_id}, missed
    )

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

    ONLY DEVICES THIS PROCESS HAS SEEN ARE CANDIDATES, and that is what makes a restart safe: an
    empty map is an absence of evidence, not evidence of absence. Seeding it from the database
    would mark a whole fleet OFFLINE on every restart -- one audit row each, in an append-only
    table -- which is a far worse failure than the stale ONLINE this watchdog exists to fix.
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

    WRITE-ON-CHANGE, and it is not an optimisation. log_digital_thread_event() fires on every
    UPDATE to `devices`, so a sweep rewriting OFFLINE each tick would append to a deliberately
    append-only audit table forever. Two things enforce it: the UPDATE carries `status = ONLINE`
    as a filter, so an already-OFFLINE row matches nothing and no trigger fires; and the device is
    dropped from tracking afterwards, so it is written once per quiet period rather than per tick.
    """
    if not supabase_client:
        return []

    written = []
    for device_id, name in stale_device_ids(now, timeout):
        try:
            # The `status = ONLINE` filter this used to carry is now inside the gate, as
            # `IS DISTINCT FROM 'OFFLINE'` -- see 0047. It is no longer a caller convention that
            # a future edit here could drop.
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

    A daemon thread, so it can never hold the process open, and forgiving of errors for the same
    reason as the health heartbeat: a failing sweep should not take down a daemon that is
    otherwise ingesting.
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


def resolve_device(wire_id: str, use_cache: bool = True):
    """
    Resolve an id seen on the wire to its `devices` row, in order of precedence:

      1. sparkplug_id      -- the platform-issued id, the current scheme.
      2. reported_identity -- a third-party device's own factory-preset id, recorded when it
                              was discovered. Such a device cannot be made to publish an
                              issued id, so its own is what must keep resolving.
      3. id                -- the Factory+ `Instance_UUID`. `devices.id` IS that identifier:
                              it is already an RFC4122 UUID, so a Factory+ gateway addressing
                              a device by Instance_UUID resolves with no extra column and no
                              second identifier namespace. Only tried when the wire id is
                              UUID-shaped, so it costs nothing on the ordinary path.
      4. name              -- legacy, pre-0014 devices. Warns; this arm goes away once every
                              gateway has been reconfigured.

    Returns the row (with `_identity_source` attached) or None if unregistered. Any failure
    resolves to None, which callers treat as "quarantined" -- the fail-closed answer.
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
        # Not cached: a transient Supabase failure must not pin this device to "unregistered"
        # for the full TTL -- and, since 2026-08, must not be REPORTED as "unregistered" either.
        # Returning None here would let a brief outage quarantine a registered device, because
        # that is how process_dbirth() answers an unregistered one. See DirectoryUnavailable.
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

    `include_archived` is for the two callers that must DESCRIBE the refusal rather than act on it
    -- verify_gateway_binding() writes a quarantine reason an operator reads, and the quarantine
    record needs to say which of the two refusals happened. They get the row and check
    `is_archived` themselves. It is a parameter rather than a second public function so that
    `resolve_gateway` stays the one seam every caller and every test patches.

    ARCHIVED IS A REFUSAL, NOT A MATCH, and it is the application tier of the same two-tier
    arrangement mosquitto.acl describes. Migration 0038 revokes a gateway's broker credential when
    it is archived, so an archived appliance should not be able to connect at all -- but that
    revocation is ASYNCHRONOUS (net.http_post queues it) and is INERT on a deployment that never
    configured GATEWAY_REVOKE_SECRET. Both leave a window in which a decommissioned appliance still
    holds a working credential, and without this it would go on stamping `last_heartbeat` and
    `status` on a row an operator has retired -- resurrecting it to ONLINE on the dashboard.

    IT REFUSES THE WHOLE EDGE NODE, devices included. A device published beneath an archived
    gateway is telemetry from decommissioned hardware whichever asset it names, and process_ddata()
    resolves the gateway before it writes.
    """
    row = _resolve_gateway_row(wire_id, group_id)
    if row is None or include_archived or not row.get("is_archived"):
        return row

    # NAMED SEPARATELY FROM "unregistered", which is the whole reason this is not simply a filter
    # in the query. "Received NDATA from unregistered edge node" sends an operator hunting a
    # provisioning fault; the truth is that somebody archived it, and that is a different fix.
    count("dropped_gateway_archived")
    if _throttled(_archived_gateway_warned, wire_id, ARCHIVED_GATEWAY_WARN_INTERVAL_SECONDS):
        logger.warning(
            "Dropping traffic from edge node '%s' (%s): the gateway is ARCHIVED. Its broker "
            "credential should have been revoked when it was archived (migration 0038) -- that it "
            "can still publish means revocation has not landed, or GATEWAY_REVOKE_SECRET is unset "
            "on this deployment. Un-archive the gateway to accept it again.",
            wire_id, row.get("name")
        )
    return None


def _resolve_gateway_row(wire_id: str, group_id: str = None):
    """
    Resolve an edge node to its `gateways` row.

    THE ADDRESS IS (group, node), which is how Factory+ addresses an edge node and why its
    Directory keys on /v1/address/{group_id}/{node_id}. Before `gateways.sparkplug_group`
    existed the group was parsed and discarded, so two groups publishing the same edge node id
    resolved to ONE row -- silently, with each group's telemetry attributed to the other's asset.

    Resolution order, and the middle arm is the migration path:

      1. (sparkplug_group, sparkplug_id) -- the current scheme.
      2. sparkplug_id alone              -- group-agnostic. Warns, throttled, naming both the
                                            group on the wire and the one on the row. Goes away
                                            once every gateway is reconfigured.
      3. name                            -- legacy, pre-0014. Warns the same way.

    Gateways are never auto-created -- an unregistered edge node is logged and dropped,
    mirroring the fail-closed treatment of unregistered devices.
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

    # `status` is read back so process_node_message() can tell a genuine ONLINE/OFFLINE transition
    # from the 119 heartbeats an hour that carry the same status as the last one. It does not gate
    # the write -- see the comment there for why that write is not skippable.
    # `is_archived` is read so resolve_gateway() above can refuse a decommissioned edge node. It
    # is fetched rather than filtered in the query on purpose: a WHERE clause would make an
    # archived gateway indistinguishable from an unregistered one, and those need different fixes.
    columns = "id,name,sparkplug_id,sparkplug_group,status,is_archived"
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
        # Raised rather than returned for the same reason as resolve_device: an unreachable
        # directory must not read as "this edge node is not registered". verify_gateway_binding()
        # turns that answer into a quarantine reason, so conflating the two reaches the same
        # wrongly-quarantined device by a slightly longer route.
        logger.error("Error resolving gateway identity '%s' in Supabase: %s", wire_id, e)
        raise DirectoryUnavailable(str(e)) from e

# -----------------------------------------------------------------------------
# Sparkplug B Ingestion Handlers
# -----------------------------------------------------------------------------
def _timestamp_is_sane(dt: datetime, now: datetime = None) -> bool:
    """
    True if `dt` falls inside the telemetry sanity window.

    Devices supply their own metric timestamps and are trusted for ordering, but a value far
    outside this window is a clock fault or a forgery, not an observation: it lands the row
    outside the retention policy, or inside an already-compressed chunk that rejects the
    write, or arbitrarily far in the future where it distorts every dashboard's axis.
    """
    now = now or datetime.now(timezone.utc)
    delta = (dt - now).total_seconds()
    return -TELEMETRY_MAX_AGE_SECONDS <= delta <= TELEMETRY_MAX_FUTURE_SECONDS


def verify_gateway_binding(device: dict, gateway_wire_id: str, group_id: str = None):
    """
    Check that the edge node publishing this message is the one the device is bound to.

    `group_id` scopes the edge node lookup -- the address is (group, node), so a node id alone
    can name two different gateways once more than one group is in use.

    Returns None when the message may be trusted, or a quarantine reason string when it may
    not. Never raises: a lookup failure is reported as a mismatch, which is the fail-closed
    answer.

    Two cases are NOT a mismatch, each guarding a branch below:

      * No `gateway_id` -- binding is set by an operator at approval, never on the telemetry
        path. Unbound is not mis-bound.
      * A node-level message -- no device segment; handled by process_node_message().

    HOW A DEVICE WAS RESOLVED DOES NOT AFFECT THIS CHECK, and it used to. A device matched by
    legacy `name` was exempted outright, on the reasoning that such a row "may predate any
    gateway assignment" -- but that case is the `bound_gateway_id` branch below, which returns
    before the exemption could ever be reached. The exemption therefore only ever fired for a
    device that IS bound, which is exactly the device it must not fire for: resolve_device()
    falls back to a `name` lookup for any wire id that is not a platform-issued `dev` id, so
    naming another gateway's device in the topic's device segment resolved it, marked it
    legacy, and skipped this function entirely. The broker cannot close that -- mosquitto.acl
    pins the topic's EDGE-NODE segment to the connecting username and leaves the device segment
    free -- so this was the only tier standing, and it stood down.

    Threat model and why the broker ACL does not make this redundant:
    ../ingestion/README.md -> "Gateway Binding"
    """
    if not device:
        return None

    bound_gateway_id = device.get("gateway_id")
    if not bound_gateway_id:
        return None

    # THE UNFILTERED ROW, because this function's job is to DESCRIBE the mismatch and the
    # description is what an operator acts on. resolve_gateway() refuses an archived edge node by
    # answering None, which here would be indistinguishable from "never registered" -- and the
    # quarantine reason below is written into `devices.quarantine_reason`, where a wrong one sends
    # somebody looking for a provisioning fault on a gateway they themselves retired.
    gateway = resolve_gateway(gateway_wire_id, group_id, include_archived=True)

    # An unregistered edge node speaking for a *registered, bound* device. resolve_gateway()'s
    # contract is that unregistered edge nodes are dropped; that was only ever enforced on the
    # node-level path, so a device message via an unknown edge node was accepted.
    if gateway is None:
        return "%s: device is bound to a gateway but the publishing edge node '%s' is not registered" % (
            REASON_GATEWAY_MISMATCH, gateway_wire_id
        )

    # ARCHIVED IS A REFUSAL EVEN WHEN THE BINDING IS CORRECT, and it has to be checked before the
    # id comparison below -- a device bound to the gateway that is publishing for it matches by
    # construction, so without this the telemetry of a decommissioned appliance would be accepted
    # on the strength of being correctly bound to the appliance that was decommissioned.
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
    Persist the metrics carried by a DBIRTH birth certificate to `asset_config`, so the
    dashboard's device Config view can show the parameters the device announced
    (firmware version, serial number, thresholds, interlocks...).

    Keyed by the device's `sparkplug_id`, not its name, so renaming the device leaves its
    recorded birth parameters attached to it.

    These are configuration parameters, not telemetry: they are stored for quarantined
    devices too, precisely so an administrator can inspect what a newly discovered
    device claims about itself *before* approving it. DDATA telemetry stays gated.
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
        # uq_asset_config_metric (asset_id, metric_name) makes this a per-metric upsert,
        # so a re-birth refreshes values instead of accumulating duplicates. The whole batch
        # goes in one call deliberately: a per-metric gate would turn one round trip into as
        # many as the birth certificate has metrics, on the hot path.
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

    Deliberately a separate pass from `store_birth_parameters`, which filters differently: it
    skips any metric carrying no recognised value field, because it is building a table of
    parameter *values*. Here the question is which metrics the device says it has, so a metric
    declared with no value still counts -- it is exactly the kind of thing a schema should
    account for.

    This is a record of what was observed, not a verdict on it. Whether any of these metrics
    fall outside the device's assigned schema is derived at read time, so that editing a schema
    reclassifies its devices immediately rather than at their next birth (which for a stable
    device could be weeks away).
    """
    return sorted({
        metric.name for metric in payload.metrics
        if metric.name and metric.name not in IDENTITY_METRICS
    })


def record_declared_metrics(device: dict, payload):
    """
    Persist the birth-declared metric names onto the device row, but only when the set has
    actually changed.

    The change check is not an optimisation. `log_digital_thread_event()` fires on every UPDATE
    to `devices`, so writing an unchanged array on every rebirth would append an audit row each
    time to a table that is deliberately immutable and append-only. Writing only on change means
    each entry in the thread marks a real change in what the device publishes -- which is
    precisely the event worth auditing.
    """
    if not supabase_client or not device:
        return

    declared = extract_declared_metrics(payload)
    if device.get("last_birth_metrics") == declared:
        return

    try:
        # The change check above stays: it saves a round trip. It is no longer what the property
        # depends on, though -- the gate carries the same `IS DISTINCT FROM` test, so a stale or
        # evicted cache entry can no longer cause an unchanged rewrite. See 0047.
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
    The device's self-reported friendly name, used only as the initial label for a newly
    discovered device.

    It is never applied to an existing row: the friendly name is platform-owned, and letting a
    DBIRTH write it back would mean a rename in the dashboard gets stomped on the device's next
    birth -- reintroducing the exact name/identity coupling this scheme removes.
    """
    for metric in payload.metrics:
        if metric.name == 'Asset_Name' and metric.HasField('string_value'):
            return metric.string_value.strip() or None
    return None


def quarantine_new_device(wire_id: str, gateway_wire_id: str, reason: str, payload,
                          group_id: str = None):
    """
    Insert a newly discovered device with is_quarantined = True, and return the created row.

    The arriving edge node is recorded on the row. Ingestion has always had it in scope and
    always discarded it, which is why approving a quarantined device previously required the
    operator to re-pick its gateway by hand.
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

    # `status` and `is_quarantined` are no longer passed: the gate pins them. This function is the
    # quarantine path and nothing else, and a caller able to send is_quarantined=False could have
    # registered an unknown device as a trusted one -- see 0047.
    #
    # `last_birth_metrics` is still carried here rather than left to record_declared_metrics'
    # UPDATE, so a newly discovered device produces one digital_thread entry instead of an insert
    # immediately chased by an update saying the same thing.
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
    On Sparkplug B DBIRTH:
    Resolve the device by its wire identity. If it is unregistered, insert it quarantined,
    recording both the id it published under and why it was held.
    Birth certificate metrics are recorded to `asset_config` either way.

    `quarantine_reason` is supplied by the caller when the identity itself was already found
    to be faulty (malformed, or contradicting the payload's Asset_ID claim). Such a device is
    still admitted to the queue rather than dropped -- silently discarding it would make a
    misconfigured gateway invisible instead of diagnosable.

    A registered device is additionally checked against the edge node that published for it
    (see verify_gateway_binding). A device announced by a gateway it is not bound to is held
    in the same way and for the same reason: what is on the wire no longer reliably
    identifies the asset.
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
            device = resolve_device(wire_id, use_cache=False)
        except DirectoryUnavailable as e:
            # DROP THE BIRTH, CHANGE NOTHING. Without this arm the directory being unreachable is
            # indistinguishable from the device being unregistered, and the branch below answers
            # "unregistered" by writing a quarantine row -- so a transient fault here would
            # register a legitimate device as UNKNOWN_DEVICE and drop its telemetry until an
            # operator approved it back out.
            #
            # Returning is safe because a birth certificate is REPEATED, not once-only: the flow
            # rebirths on a timer, and ingestion asks for one itself (request_rebirth) whenever it
            # sees an alias it cannot decode. The aliases from this payload are already registered
            # above, so nothing is lost by waiting for the next one.
            logger.warning(
                "DIRECTORY UNAVAILABLE: dropping DBIRTH for '%s' without registering it (%s). "
                "The device is NOT quarantined -- this is a transport fault, not an identity "
                "one. The next birth certificate will resolve normally.",
                wire_id, e
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
                # A registered device publishing a faulty identity, or announced by a gateway
                # it is not bound to. Re-quarantine it: whatever is on the wire no longer
                # reliably identifies this asset.
                # `is_quarantined` is pinned true by the gate: this direction only ever tightens.
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
                # WRITE ONLY WHAT MOVED. A birth certificate is REPEATED -- the shipped flow
                # rebirths on a timer and ingestion asks for one whenever it meets an alias it
                # cannot decode -- so an unconditional UPDATE here fires once per rebirth per
                # device, forever, and changes nothing on all but the first.
                #
                # The audit trigger already refuses to record such a write (migration 0005
                # subtracts nothing and compares the rows, so an identical UPDATE writes no
                # digital_thread row). What it CANNOT suppress is the write itself: the round
                # trip to PostgREST, the WAL record, and -- because `devices` is REPLICA IDENTITY
                # FULL and published to `supabase_realtime` -- a full-row change event broadcast
                # to every connected dashboard. This is the half of that problem that has to be
                # fixed on this side of the wire.
                #
                # Same shape as record_declared_metrics() below, and for the same reason.
                #
                # first_dbirth_at is write-once. The check below still avoids sending it when the
                # row already has one, but the gate is what enforces it now: it COALESCEs against
                # the stored value, so a stale cache entry can no longer move an original birth
                # timestamp. See 0047.
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
        # The directory went away PART WAY THROUGH -- after resolve_device() succeeded, inside
        # verify_gateway_binding() or quarantine_new_device(). Caught explicitly rather than left
        # to the generic arm below so the log says what happened; either way nothing further is
        # written, which is the property that matters.
        logger.warning(
            "DIRECTORY UNAVAILABLE part way through DBIRTH for '%s' (%s). No device state was "
            "changed; the next birth certificate will complete it.", wire_id, e
        )
    except Exception as e:
        logger.error("Error checking/updating Supabase devices for DBIRTH: %s", e, exc_info=True)


def process_ddeath(wire_id: str, gateway_wire_id: str):
    """
    On Sparkplug B DDEATH: mark the registered device OFFLINE in Supabase so the
    dashboard's "OFFLINE / DDEATH" state reflects the actual death certificate.
    """
    logger.info("Processing DDEATH for device '%s' via edge node '%s'", wire_id, gateway_wire_id)
    if not supabase_client:
        logger.warning("Supabase client unavailable. Skipping DDEATH status update for '%s'", wire_id)
        return

    try:
        device = resolve_device(wire_id)
    except DirectoryUnavailable as e:
        # A death certificate is a status update, not telemetry. Losing one means the row keeps
        # saying ONLINE until DEVICE_OFFLINE_TIMEOUT_SECONDS elapses and the watchdog corrects it,
        # which is the mechanism that exists for exactly this -- a device that stops speaking
        # without announcing it.
        logger.warning(
            "DIRECTORY UNAVAILABLE: dropping DDEATH for '%s' (%s). The watchdog will mark it "
            "OFFLINE if it stays silent.", wire_id, e
        )
        return

    if device is None:
        logger.warning("DDEATH received for unregistered device '%s'; nothing to update", wire_id)
        return

    try:
        # Same gate as the watchdog. This path used to write unconditionally; the gate suppresses
        # the write when the row is already OFFLINE, which saves a round trip and a realtime
        # broadcast and reaches the same state either way.
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

    A gateway names its own operating states -- that is what keeps `gateways.status` an open
    domain -- but it does not get to name the platform's. See RESERVED_GATEWAY_STATUSES.

    Returns the accepted string (whitespace-trimmed) or None, which the caller answers by
    keeping the status the message type implies.
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
# WHAT AN APPLIANCE REPORTS ABOUT ITSELF, and where each value lands. Migration 0035 carries the
# argument for the columns; this is the wire contract.
#
# NO NEW TRANSPORT, CREDENTIAL OR TABLE. These arrive as ordinary metrics on the node-level message
# the appliance already publishes every 30s over a connection it already holds. `on_message()`
# routes node-level topics here and returns before `process_ddata()`, so none of this reaches the
# historian or `metric_catalog` -- which is what makes it cheap, and also why it is CURRENT STATE
# WITH NO HISTORY.
#
# `Agent_Version` writes the column `0025` stamps at enrolment. That is the point rather than a
# collision: enrolment was the only moment the platform ever heard which bundle an appliance runs,
# so an in-place upgrade was invisible until the appliance re-enrolled.
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
#
# DELIBERATELY NOT "IN THE FUTURE". An ALREADY-EXPIRED CA is the exact condition this metric exists
# to surface, so a notAfter in the past is a valid and important reading. Only values that cannot
# be a certificate date at all are refused -- a zero, a seconds-vs-milliseconds mix-up, a garbled
# parse.
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

    VALIDATED HERE RATHER THAN BY A CHECK CONSTRAINT, and migration 0035 records why: these
    columns are written in the SAME UPDATE as `status` and `last_heartbeat`. A constraint
    violation would fail that whole statement, so one nonsensical disk figure would stop a live
    gateway reporting ONLINE -- a cosmetic fault presenting as an outage. A metric that fails
    validation is dropped and counted; every other metric in the payload, and the heartbeat
    itself, still lands.

    Returns {} when nothing recognised is present, which is the ordinary case for the platform's
    own simulators and for any appliance on a bundle predating this.
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
# WHY BOTH. `gateways.disk_free_bytes` and its neighbours hold a LATEST VALUE AND NO HISTORY, which
# migration 0035 states plainly. So a dashboard reading the database can answer "how full is that
# disk" and can never answer "is it filling" -- the question an operator actually acts on. These
# gauges are that second answer, at the scrape interval, over the Prometheus the stack already runs.
#
# FOUR OF THE SEVEN, AND THE OMISSIONS ARE THE POINT. The metrics endpoint needs no credential and
# is published to the host, so `agent_version`, `flow_hash` and `cert_expires_at` stay in the
# database: the first two are a fingerprint of an appliance's deployed configuration, the third is
# a fixed date that gains nothing from a time series and is the single most useful fact an attacker
# on that port could learn. metrics.py's header carries the full argument.
GATEWAY_HEALTH_GAUGES = {
    "uptime_seconds":      "acs_ingestion_gateway_uptime_seconds",
    "load_1m":             "acs_ingestion_gateway_load1",
    "mem_available_bytes": "acs_ingestion_gateway_mem_available_bytes",
    "disk_free_bytes":     "acs_ingestion_gateway_disk_free_bytes",
}

HEALTH_REPORTED_GAUGE = "acs_ingestion_gateway_health_reported_timestamp_seconds"

# Last-seen values per edge node. BOUNDED BY THE FLEET WITHOUT NEEDING A CAP: this is written only
# after resolve_gateway() has matched a REGISTERED gateway, so an unknown or forged edge node id
# cannot add an entry -- which is the same argument the cache bound makes, arrived at for free.
# An archived gateway's series lingers until the daemon restarts; its reported-at timestamp is
# what says so.
_gateway_health_gauges = {}
_gateway_health_gauges_lock = threading.Lock()


def record_gateway_health_gauges(edge_node_id, health, at):
    """
    Merge one payload's readings into this edge node's gauge set.

    MERGED, NOT REPLACED, so a payload carrying only what its collector could produce does not
    silently zero the rest. The reported-at gauge moves whenever anything was recognised, which is
    what lets a reader tell a steady disk figure from a dead collector -- a gauge holds its last
    value forever and says nothing about its own age.
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
    On Sparkplug B node-level messages (NBIRTH / NDATA / NDEATH):
    Update the matching `gateways` row's status and last_heartbeat in Supabase.

    NBIRTH/NDATA mark the edge node ONLINE; NDEATH marks it OFFLINE. A `Gateway_Status`
    string metric in the payload (what node_red_flow.json publishes) overrides the
    status derived from the message type -- subject to accept_reported_status().

    Gateways are never auto-created: an unregistered edge node is logged and dropped,
    mirroring the fail-closed treatment of unregistered devices.
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
        # Throttled on the same key as the unregistered-node warning below: a heartbeat arrives
        # every 30s, and a directory that is down is down for all of them.
        if _throttled(_unknown_gateway_warned, edge_node_id, UNKNOWN_GATEWAY_WARN_INTERVAL_SECONDS):
            logger.warning(
                "DIRECTORY UNAVAILABLE: dropping %s from edge node '%s' (%s). This is NOT the "
                "unregistered-node path -- nothing is written and the next heartbeat retries.",
                msg_type, edge_node_id, e
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

    # THIS WRITE IS NOT SKIPPABLE, and the comparison below is not a guard on it. `last_heartbeat`
    # has to move on every heartbeat because `public.gateway_status` derives staleness from it at
    # read time -- suppressing the write would make a live gateway report STALE, which is a far
    # worse failure than the noise it would save. Migration 0005 is what keeps this out of the
    # audit trail: it subtracts `last_heartbeat` before comparing, so a heartbeat that moves only
    # the timestamp writes no digital_thread row while a genuine ONLINE/OFFLINE transition still
    # does.
    #
    # The comparison exists only to tell the two apart IN THE LOG. A transition is an operational
    # event worth finding later; the other 119 heartbeats an hour are not.
    previous_status = gateway.get("status")
    transitioned = previous_status is not None and previous_status != status

    # AFTER the registration check, not before: an unregistered node is dropped either way, and
    # validating its metrics first would log rejections for a gateway nothing is going to write.
    #
    # `health_reported_at` is no longer stamped here: the gate stamps it, and only when the health
    # object is non-empty. That is what makes the column mean what 0035 says it means -- an
    # appliance on a bundle predating health reporting beats forever and leaves it NULL, reading as
    # "does not report health" rather than "has stopped reporting it".
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
# WHAT THIS DOES NOT DO, STATED FIRST BECAUSE IT IS THE DESIGN DECISION THAT MATTERS.
#
# It does not drop telemetry. A metric that no schema models, or whose type contradicts the one its
# schema declares, is STILL WRITTEN to the historian exactly as before. That is not timidity about
# changing behaviour; it is the same principle extract_declared_metrics() already states -- the
# historian records what was observed, and whether an observation was supposed to happen is a
# judgement made at read time, against a schema an engineer can edit afterwards. Refusing the row
# would destroy the evidence of the very fault being reported, and would do it on the strength of a
# schema that may itself be the thing that is wrong.
#
# What it adds is the RECORD. Until now a non-conforming payload produced nothing at all -- not a
# counter, not a row -- so "this machine has been publishing a metric nobody modelled since
# Tuesday" was unanswerable. Now it is one SCHEMA_REJECTION row in the digital thread.
#
# THE DROPPED METRICS ARE INCLUDED FOR THE SAME REASON. A metric skipped for an unresolvable alias
# or a timestamp outside the sanity window IS genuinely lost, and those were `logger.warning` and a
# counter -- both of which vanish on restart. Those two carry `dropped: true` so a reader can tell
# a lost sample from a recorded-but-unmodelled one, which is the distinction that decides whether
# anyone needs to go and look at the gateway.

# JSON Schema type names satisfied by each Sparkplug value column. `integer` is accepted for a
# double because Sparkplug has no integer wire type that survives this far -- process_ddata casts
# int_value and long_value to float -- so rejecting `{"type": "integer"}` would flag every
# correctly-modelled counter in the plant.
_JSON_TYPES_FOR_VALUE = {
    "double": frozenset({"number", "integer"}),
    "string": frozenset({"string"}),
    "bool": frozenset({"boolean"}),
}

# device_uuid -> ModelledSchema (or None -- see device_modelled_constraints).
#
# BOUNDED FOR CONSISTENCY RATHER THAN FOR SAFETY, and the difference is worth stating. This is keyed
# on a RESOLVED uuid, which only exists because a `devices` row does, so no publisher can push
# arbitrary keys into it the way it can into _device_cache -- it really is bounded by the fleet.
# It gets the same container anyway: three caches with two different growth stories is how the
# second one gets missed, which is how this one was missed when MAX_ALIASES_PER_NODE was written.
_schema_cache = TTLCache(MAX_ENTITIES_PER_CACHE, SCHEMA_CACHE_TTL_SECONDS, "schema")


class MetricConstraint(NamedTuple):
    """
    What every attached schema, taken together, permits one metric to carry.

    `None` on any field means UNCONSTRAINED for that facet, which is not the same as absent: a
    metric named in `required` but not in `properties` is modelled with no constraints at all, and
    reading that as "declares nothing" would make every value it carries a mismatch.
    """
    types:   frozenset = None   # JSON Schema `type`, as a set of names
    enum:    frozenset = None   # `enum`, as a set of permitted scalars
    minimum: float     = None
    maximum: float     = None
    pattern: str       = None   # `pattern`, a regular expression, strings only


class ModelledSchema(NamedTuple):
    """
    The resolved schema surface for a device: what each metric may carry, and whether anything NOT
    named is permitted at all.

    `closed` is `additionalProperties: false` on any attached schema. It sits beside the metric map
    rather than inside it because it is a statement about the SET, not about any one metric -- and
    it is the only thing that can make an unmodelled metric a rejectable fault rather than merely a
    reportable one. JSON Schema's default is to permit unnamed properties, so silence means yes.
    """
    metrics: dict
    closed:  bool = False


def _widen(a, b, union):
    """
    Combine one facet across two schemas, PERMISSIVELY.

    `None` wins, because the union is what the device is PERMITTED to send and the widest
    permission is the answer: a schema declaring a metric with no `enum` permits any value, and
    another schema listing some cannot narrow that.
    """
    if a is None or b is None:
        return None
    return union(a, b)


def modelled_constraints(schema_definitions):
    """
    Metric name -> MetricConstraint across every attached schema, plus whether the set is closed.

    THE UNION ACROSS SCHEMAS IS DELIBERATE and mirrors modelled_metrics_across() in validate.py: a
    device may carry several submodels, and a metric modelled by any one of them is modelled. A
    per-schema check would flag a device for publishing what another of its own submodels accounts
    for.

    Was `modelled_types()`, which read `type` and nothing else -- so `enum`, `minimum`, `maximum`,
    `pattern` and `additionalProperties` sat in stored schemas and were read past in silence. The
    documents were already JSON Schema; only the reader was shallow.
    """
    result = {}
    closed = False

    for definition in schema_definitions or []:
        if not isinstance(definition, dict):
            continue

        # `additionalProperties: false` on ANY attached schema closes the set. Any is the right
        # quantifier: a schema saying "nothing beyond these" is an assertion about the whole
        # device, and another submodel staying silent is not a contradiction of it.
        if definition.get("additionalProperties") is False:
            closed = True

        properties = definition.get("properties")
        properties = properties if isinstance(properties, dict) else {}

        # RESOLVED PER SCHEMA BEFORE THE UNION, and the two steps cannot be collapsed. Within ONE
        # schema, `required: ["M"]` alongside `properties: {"M": {"type": "number"}}` means M is
        # required AND typed -- the `required` entry adds no type information and must not erase
        # the one next to it. ACROSS schemas the opposite holds: a schema that declares M with no
        # type permits any value, which widens the union to unconstrained.
        #
        # Folding both into a single pass gets the answer right only when the schemas happen to
        # arrive in a convenient order, which is a bug that hides until a device gains a second
        # submodel.
        this_schema = {}

        for name, spec in properties.items():
            if not isinstance(name, str):
                continue
            if not isinstance(spec, dict):
                this_schema[name] = MetricConstraint()
                continue

            declared = spec.get("type")
            if isinstance(declared, str):
                types = frozenset({declared})
            elif isinstance(declared, list):
                types = frozenset(t for t in declared if isinstance(t, str))
            else:
                types = None

            raw_enum = spec.get("enum")
            if isinstance(raw_enum, list) and raw_enum:
                enum = frozenset(v for v in raw_enum if isinstance(v, (str, int, float, bool)))
                enum = enum or None
            else:
                enum = None

            # exclusiveMinimum / exclusiveMaximum are deliberately NOT read. Draft 4 spells them as
            # booleans modifying `minimum`, Draft 6+ as numbers replacing it, and guessing which
            # dialect a stored document means would move a boundary in whichever direction the
            # guess was wrong. An unread facet reports nothing; a misread one rejects good
            # telemetry, and this is the half of the file that can now drop a reading.
            minimum = _number_or_none(spec.get("minimum"))
            maximum = _number_or_none(spec.get("maximum"))

            pattern = spec.get("pattern")
            pattern = pattern if isinstance(pattern, str) and pattern else None

            this_schema[name] = MetricConstraint(types, enum, minimum, maximum, pattern)

        for name in definition.get("required") or []:
            if isinstance(name, str):
                this_schema.setdefault(name, MetricConstraint())

        for name, c in this_schema.items():
            if name not in result:
                result[name] = c
            else:
                prev = result[name]
                result[name] = MetricConstraint(
                    types=_widen(prev.types, c.types, lambda x, y: x | y),
                    enum=_widen(prev.enum, c.enum, lambda x, y: x | y),
                    # The widest bound survives: a floor of 0 in one schema and 10 in another
                    # permits anything at or above 0.
                    minimum=_widen(prev.minimum, c.minimum, min),
                    maximum=_widen(prev.maximum, c.maximum, max),
                    # Two patterns cannot be combined into one expression meaning "either" short of
                    # building an alternation and hoping both are well formed. Differing patterns
                    # therefore widen to unconstrained, which is the rule every other facet follows.
                    pattern=_widen(prev.pattern, c.pattern, lambda x, y: x if x == y else None),
                )

    return ModelledSchema(result, closed)


def _number_or_none(value):
    """A JSON number, or None. `True` is an int in Python and is not a bound."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def device_modelled_constraints(device_uuid: str):
    """
    The cached ModelledSchema for a device, or None when it has no schema attached at all.

    NONE AND AN EMPTY MAP ARE DIFFERENT ANSWERS and the caller depends on it. None means no schema
    is bound, so there is nothing to judge against and conformance is not evaluated -- the ordinary
    state of a newly onboarded device. An empty map means a schema IS bound and models no metrics,
    which makes every metric unmodelled and is worth reporting.
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


def constraint_violations(name, value_kind, value, constraint):
    """
    Every facet of one constraint that this value fails, as (code, detail, extra) tuples.

    SEPARATE FROM payload_violations() SO IT CAN BE TESTED WITH THREE LITERALS. It takes no
    payload, no client and no device -- which is the same reason payload_violations() itself is
    pure, applied one level down now that there are five facets rather than one.

    ORDER IS SIGNIFICANT AND TYPE COMES FIRST. A value of the wrong type fails `minimum` and
    `pattern` too, and reporting three faults for one mistake buries the one that explains the
    other two. So a type mismatch returns alone.
    """
    satisfied = _JSON_TYPES_FOR_VALUE.get(value_kind, frozenset())

    if constraint.types is not None and not (satisfied & constraint.types):
        return [("type_mismatch",
                 "schema declares %s" % "/".join(sorted(constraint.types)),
                 {"expected_types": sorted(constraint.types)})]

    out = []

    if constraint.enum is not None and value not in constraint.enum:
        # Sorted on the string form: an enum may legitimately mix strings and numbers, which are
        # not orderable against each other in Python 3.
        listed = sorted(constraint.enum, key=lambda v: str(v))
        out.append(("enum_mismatch",
                    "schema permits %s" % ", ".join(repr(v) for v in listed),
                    {"permitted": [v for v in listed]}))

    # Bounds apply to numbers only. A string carrying a `minimum` in its schema is a schema fault,
    # not a telemetry fault, and comparing the two in Python 3 raises rather than answering.
    if value_kind == "double" and isinstance(value, (int, float)):
        if constraint.minimum is not None and value < constraint.minimum:
            out.append(("below_minimum",
                        "schema sets minimum %g" % constraint.minimum,
                        {"minimum": constraint.minimum}))
        if constraint.maximum is not None and value > constraint.maximum:
            out.append(("above_maximum",
                        "schema sets maximum %g" % constraint.maximum,
                        {"maximum": constraint.maximum}))

    if constraint.pattern is not None and value_kind == "string" and isinstance(value, str):
        try:
            if re.search(constraint.pattern, value) is None:
                out.append(("pattern_mismatch",
                            "schema requires a match for %s" % constraint.pattern,
                            {"pattern": constraint.pattern}))
        except re.error:
            # A stored schema carrying an invalid regular expression is the schema author's fault
            # and must not be charged to the device. Reported against the SCHEMA so it is visible,
            # and deliberately never enforced -- see enforceable_violation().
            out.append(("schema_pattern_invalid",
                        "schema pattern %s is not a valid regular expression"
                        % constraint.pattern,
                        {"pattern": constraint.pattern}))

    return out


def payload_violations(observed, dropped, modelled):
    """
    Everything wrong with one DDATA payload, as a list of audit-shaped dicts.

    `observed` -- [(metric_name, value_kind, value)] for metrics the loop accepted, where
                  value_kind is a key of _JSON_TYPES_FOR_VALUE. The VALUE is carried because
                  `enum`, `minimum`, `maximum` and `pattern` are about values and not about types;
                  before those were read, the kind alone was enough.
    `dropped`  -- [(metric_name_or_None, code, detail)] for metrics the loop skipped.
    `modelled` -- the ModelledSchema from device_modelled_constraints(), or None to skip the schema
                  half entirely.

    Pure, and that is the point: every branch below is reachable from a unit test with three
    literals, which is not true of anything that has to be handed a protobuf and a live client.
    """
    violations = []

    for name, code, detail in dropped:
        violations.append({
            "metric": name,
            "code": code,
            "detail": detail,
            # The half that is genuinely lost. See the section header.
            "dropped": True,
        })

    if modelled is None:
        return violations

    for name, value_kind, value in observed:
        constraint = modelled.metrics.get(name)

        if constraint is None:
            violations.append({
                "metric": name,
                "code": "unmodelled_metric",
                "detail": ("no attached schema declares this metric, and one of them closes the "
                           "set with additionalProperties: false"
                           if modelled.closed else
                           "no attached schema declares this metric"),
                "observed_type": value_kind,
                "dropped": False,
            })
            continue

        for code, detail, extra in constraint_violations(name, value_kind, value, constraint):
            violations.append({
                "metric": name,
                "code": code,
                "detail": detail,
                "observed_type": value_kind,
                "dropped": False,
                **extra,
            })

    return violations


def enforceable_violation(violation, closed):
    """
    Whether this finding justifies DROPPING the metric, as opposed to only recording it.

    THE TWO ARE NOT THE SAME QUESTION and the difference is the whole of the policy. Recording is
    free and always correct: the row says what was observed. Dropping discards a reading a machine
    actually produced, so it is reserved for findings where the schema is unambiguous about the
    value being wrong.

      * `type_mismatch`, `enum_mismatch`, `below_minimum`, `above_maximum`, `pattern_mismatch`
        are the device contradicting a constraint its own bound schema states. Enforceable.

      * `unmodelled_metric` is enforceable ONLY when a schema closes the set with
        `additionalProperties: false`. JSON Schema's default permits unnamed properties, so
        silence is permission -- dropping on silence would delete every reading from a device that
        had gained a sensor before anyone updated its schema, which is the ordinary way a fleet
        changes.

      * `schema_pattern_invalid` is never enforceable. The fault is in the stored schema, and
        charging it to the device would silence a machine because somebody typed a bad regex.

      * Anything already `dropped` was skipped by the loop for its own reasons -- an unresolved
        alias, a timestamp outside the sanity window -- and is not this policy's to re-decide.
    """
    if violation.get("dropped"):
        return False
    code = violation.get("code")
    if code == "unmodelled_metric":
        return bool(closed)
    return code in _ENFORCEABLE_CODES


_ENFORCEABLE_CODES = frozenset({
    "type_mismatch", "enum_mismatch", "below_minimum", "above_maximum", "pattern_mismatch",
})


def _violation_signature(violations):
    """
    A hashable summary of WHAT is wrong, ignoring how often and when.

    Deliberately excludes `detail` and every count: a device publishing the same unmodelled metric
    on every message has one problem, not one per message, and the audit trail should say so once.
    """
    return frozenset((v.get("metric"), v.get("code")) for v in violations)


# {device_uuid: signature}. In-memory, so a daemon restart re-reports each distinct fault once --
# which is the right trade: an operator who restarts ingestion to clear a fault wants to know
# whether it came back.
_last_violation_signature = {}


def record_payload_violations(device: dict, violations, observed_at):
    """
    Write one SCHEMA_REJECTION row to the digital thread, but only when the fault is NEW.

    THE CHANGE CHECK IS NOT AN OPTIMISATION -- it is the difference between a feature and an
    outage. DDATA arrives continuously; under report-by-exception a busy cell publishes several
    messages a second. Writing a row per non-conforming message would append tens of thousands of
    rows a day to a table that is append-only and that NO application role can prune, and the first
    symptom would be the disk filling. Migration 0005 made exactly this argument about heartbeat
    UPDATEs; this is the same argument about a path 0005 cannot see, because these rows are written
    through an RPC rather than by the audit trigger.

    So: write when the SET of (metric, code) pairs changes, and never otherwise. A device whose
    fault persists is recorded once; a device that develops a second fault is recorded again.
    """
    if not AUDIT_PAYLOAD_REJECTIONS or not supabase_client or not device:
        return

    device_id = device.get("id")
    if not device_id:
        return

    signature = _violation_signature(violations)

    if not violations:
        # RECOVERY CLEARS THE MEMO, so a fault that returns after being fixed is recorded again.
        # Without this, a device that was repaired and then regressed would stay silent forever --
        # the worst possible failure for an audit trail, because it is indistinguishable from
        # health.
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


def process_ddata(wire_id: str, gateway_wire_id: str, payload, group_id: str = None, client=None):
    """
    On Sparkplug B DDATA:
    Verify device registration, quarantine status and gateway binding in Supabase.
    If quarantined, missing, or announced by a gateway the device is not bound to, drop the
    DDATA telemetry.
    Otherwise, insert metric timestamps and values into TimescaleDB telemetry hypertable,
    keyed by the device's immutable `sparkplug_id` so a rename never breaks the series.

    Metric names are resolved through the edge node's alias table, since a DATA message
    legitimately carries an alias and no name. A metric whose alias is unknown is skipped and a
    rebirth is requested for the node -- see request_node_rebirth().
    """
    try:
        device = resolve_device(wire_id)
    except DirectoryUnavailable as e:
        # Telemetry DOES fail closed -- a row that cannot be attributed is not written. The
        # difference from the old behaviour is only that nothing is written about the DEVICE
        # either: the message is dropped and the stream resumes on its own, instead of the device
        # being pinned to "unregistered" for CACHE_TTL_SECONDS or quarantined by its next DBIRTH.
        count("dropped_directory_unavailable")
        logger.warning(
            "DIRECTORY UNAVAILABLE: dropping DDATA for '%s' (%s). Not quarantined; the stream "
            "resumes when the directory returns.", wire_id, e
        )
        return

    if device is None or device.get("is_quarantined"):
        count("dropped_quarantined_or_unregistered")
        logger.warning("Dropping DDATA for quarantined/unregistered device '%s'", wire_id)
        return

    # The telemetry half of the spoofing fix. Dropped rather than quarantined here: a DDATA
    # stream carries no birth certificate, so there is nothing for an operator to inspect, and
    # letting an unbound publisher quarantine a healthy device would hand it the denial of
    # service this check exists to prevent. The device's own gateway keeps being believed and
    # its DBIRTH path is what raises the alarm.
    try:
        binding_fault = verify_gateway_binding(device, gateway_wire_id, group_id)
    except DirectoryUnavailable as e:
        # The binding could not be CHECKED, so the row must not be written -- an unverifiable
        # attribution is exactly what this check exists to refuse. Dropped, not quarantined, for
        # the reason stated above: a DDATA stream must never be able to quarantine a device.
        count("dropped_directory_unavailable")
        logger.warning(
            "DIRECTORY UNAVAILABLE: cannot verify gateway binding for '%s' (%s); dropping DDATA "
            "rather than attributing it unverified.", wire_id, e
        )
        return

    if binding_fault:
        count("dropped_gateway_binding")
        logger.warning(
            "Dropping DDATA for device '%s' published via edge node '%s': %s",
            wire_id, gateway_wire_id, binding_fault
        )
        return

    # After the binding check, not before: a message from a publisher we have just refused to
    # believe is not evidence that the real device is alive.
    mark_device_seen(device)

    asset_id = device["sparkplug_id"]
    asset_name = device.get("name") or asset_id

    # THE CLOCK STARTS BEFORE THE CONNECTION IS ACQUIRED, not at the INSERT. What bounds this
    # daemon is how long the one callback thread is occupied per message, and a reconnect occupies
    # it for up to DB_CONNECT_MAX_ATTEMPTS * DB_CONNECT_BACKOFF_SECONDS while the whole fleet
    # waits -- the stall get_timescaledb_connection() accepts on purpose. Timing only the INSERT
    # would make that stall invisible in the one series meant to expose it.
    write_started = time.perf_counter()

    db_conn = get_timescaledb_connection()
    if not db_conn:
        count("dropped_db_unavailable")
        logger.warning("TimescaleDB connection unavailable. Skipping DDATA telemetry ingestion for '%s'", wire_id)
        return

    payload_ts = payload.timestamp if hasattr(payload, 'timestamp') and payload.timestamp > 0 else int(time.time() * 1000)
    payload_dt = datetime.fromtimestamp(payload_ts / 1000.0, timezone.utc)

    # DECLARED OUT HERE so they survive the try, and so the conformance record is written only
    # after the telemetry write has actually committed. An exception inside rolls the batch back
    # and leaves these unread, which is correct: a message whose rows were never stored is not
    # evidence about the device, it is evidence about the database.
    observed = []
    dropped = []

    # RESOLVED BEFORE THE WRITE, WHICH IS THE STRUCTURAL CHANGE ENFORCEMENT NEEDED (item 7).
    #
    # Conformance used to be evaluated entirely after the commit, and the comment down there still
    # explains why the RECORD belongs there: a rejection row asserts something about the device,
    # and a batch that rolled back is evidence about the database instead. That reasoning is about
    # writing the audit row, and it is untouched.
    #
    # Dropping is a different question and has to be answered before the rows are built, so the
    # constraints have to be in hand here. The lookup is skipped entirely when neither consumer
    # wants it -- the same instinct as the existing AUDIT_PAYLOAD_REJECTIONS guard, which exists
    # because device_modelled_constraints() can issue a PostgREST round trip on a cache miss.
    enforcing = bool(device) and device.get("conformance_policy") == CONFORMANCE_ENFORCE
    modelled = (
        device_modelled_constraints(device["id"])
        if device and (enforcing or AUDIT_PAYLOAD_REJECTIONS)
        else None
    )
    # A device set to enforce whose schema could not be read is NOT enforced against. None means
    # either "nothing is bound" or "the directory blinked", and neither is grounds for discarding
    # a reading -- the second especially, since it would make our own outage look like the
    # device's fault.
    enforcing = enforcing and modelled is not None
    rejected_schema = 0

    try:
        with db_conn:
            with db_conn.cursor() as cur:
                # Ensure asset entry exists in TimescaleDB assets table to satisfy foreign key
                # constraint. asset_name is a display-only cached copy of the Supabase label, so
                # it is refreshed on every birth rather than left stale after a rename.
                cur.execute(
                    """
                    INSERT INTO assets (asset_id, asset_name) VALUES (%s, %s)
                    ON CONFLICT (asset_id) DO UPDATE SET asset_name = EXCLUDED.asset_name;
                    """,
                    (asset_id, asset_name)
                )

                # Rows are ACCUMULATED and written in ONE statement below rather than executed
                # per metric. The loop's decisions are unchanged; only the write is moved.
                #
                # THIS DOES NOT CHANGE FAILURE GRANULARITY, which is the usual objection. The loop
                # already ran inside `with db_conn:` -- a transaction block that rolls back
                # wholesale on any exception -- so a bad row aborted the whole message before this
                # change and aborts the whole message after it. What changes is the number of
                # round trips: one per metric becomes one per message.
                rows = []
                rejected_timestamps = 0
                unresolved_aliases = 0
                for metric in payload.metrics:
                    # -----------------------------------------------------------------------
                    # `observed` and `dropped` are filled alongside the decisions the loop was
                    # already making -- never by a second pass. A separate conformance walk over
                    # the payload would have to re-resolve every alias and re-derive every value
                    # kind, and would then be free to disagree with what was actually written,
                    # which is the one thing an audit record must not do.
                    # -----------------------------------------------------------------------
                    # The alias is the only identity an optimised DATA metric carries. Resolve
                    # before every other test, including the identity-metric filter -- comparing
                    # an empty name against IDENTITY_METRICS never matches, so an aliased Asset_ID
                    # would otherwise be written to the historian as a metric.
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

                    # Reject rather than clamp. Clamping to the window edge would silently
                    # relabel a reading as having happened at a time it did not, which is a
                    # worse corruption of a historian than dropping it -- and it would pile
                    # every sample from a broken clock onto one timestamp, where the primary
                    # key would collapse them into a single row anyway.
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

                    # WHICH OF THE THREE COLUMNS THE VALUE LANDS IN is exactly what a JSON Schema
                    # `type` constrains, so the conformance check reads this rather than
                    # re-inspecting the protobuf. The four numeric wire types collapse to one kind
                    # here for the same reason they collapse to one column.
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
                        # A metric carrying no recognised value field. Skipped before this change
                        # too, and skipped in silence -- no counter, no log line, nothing. It is a
                        # genuine loss and now says so.
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
                    # THE OFFENDING METRIC ONLY, not the message. This mirrors how an unresolved
                    # alias and an out-of-window timestamp are already handled a few lines up:
                    # dropping the whole payload would discard samples that conform perfectly
                    # well, and the loss would be far larger than the fault.
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
                            # LOUD, AND NAMING BOTH SIDES. The schema cache has a five-minute TTL,
                            # so an edit starts discarding telemetry up to five minutes after
                            # somebody made it -- long enough that the two are not obviously
                            # connected. A line that names the device, the metric and the
                            # constraint is what makes that connection findable afterwards.
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

                metric_count = len(rows)

                # DO NOTHING, not DO UPDATE. The historian is an append-only record of what was
                # observed; an upsert let any publisher rewrite history at a timestamp of its
                # choosing, which is not a capability a time-series store should offer to the
                # devices feeding it. A genuine duplicate is a redelivered MQTT message and the
                # first write already recorded it.
                #
                # GUARDED ON A NON-EMPTY LIST: execute_values with no rows emits a syntactically
                # invalid statement (`VALUES` with nothing after it). A message whose every metric
                # was filtered -- all identity metrics, or every timestamp rejected -- is entirely
                # ordinary and must not raise.
                #
                # page_size caps how many tuples go into one statement; beyond it psycopg2 sends
                # several. 500 is far above any real Sparkplug payload, so in practice every
                # message is one statement, while a pathological payload still cannot build an
                # unbounded query string.
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

                # Counted inside the transaction block but after the loop, so this reflects rows
                # the commit is about to make durable. An exception below unwinds the write and
                # skips this, keeping the counter honest rather than optimistic.
                count("metrics_written", metric_count)
                count("metrics_rejected_timestamp", rejected_timestamps)
                count("metrics_unresolved_alias", unresolved_aliases)
                count("metrics_rejected_schema", rejected_schema)

                if unresolved_aliases:
                    # Skip the undecodable metrics, keep the rest, and ask the node to re-birth.
                    # Dropping the whole message would discard samples that resolved perfectly
                    # well; in the case that actually matters -- a cold start, where every metric
                    # is alias-only -- the two are identical, because nothing resolves. This
                    # mirrors how rejected_timestamps is handled a few lines down.
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

                logger.info("INGESTED DDATA: Ingested %d metrics for asset '%s' into TimescaleDB", metric_count, asset_id)

        # OUTSIDE `with db_conn`, WHICH IS THE POINT: the block commits on exit, and on a
        # hypertable the commit is where the write becomes durable. An observation taken at the
        # end of the cursor block would report everything except the part that touches the disk.
        # Reached only when the commit itself succeeded -- a commit that raises goes to `except`
        # below and is deliberately not observed.
        observe_write_seconds(time.perf_counter() - write_started)
    except Exception as e:
        # The whole message is lost: `with db_conn` rolled the transaction back, so none of the
        # batch landed. Counted so the loss is visible in STATS rather than only in the log --
        # a write that fails once a minute is invisible in a log nobody is tailing.
        count("write_failures")
        logger.error("Error writing DDATA telemetry to TimescaleDB: %s", e, exc_info=True)
        return

    # -------------------------------------------------------------------------------------
    # Conformance, AFTER the commit and OUTSIDE the transaction.
    #
    # Outside because this writes to Supabase over PostgREST, not to the historian: holding a
    # TimescaleDB transaction open across an HTTP round trip would put network latency inside a
    # lock on the hottest path in the process.
    #
    # After because a rejection row asserts something about the DEVICE. If the batch rolled back,
    # the honest statement is that we know nothing about this message -- hence the early return
    # above rather than falling through.
    # -------------------------------------------------------------------------------------
    # The flag is tested HERE as well as inside record_payload_violations, and the duplication is
    # deliberate: device_modelled_constraints() can issue a PostgREST round trip on a cache miss,
    # and a daemon with auditing off must not pay for a lookup whose only consumer is disabled.
    if AUDIT_PAYLOAD_REJECTIONS:
        # `modelled` was resolved before the write and is reused rather than re-read: it is the
        # same cached value, and fetching it twice would double the round trips on a cache miss
        # for a device that is enforcing.
        record_payload_violations(
            device,
            payload_violations(observed, dropped, modelled),
            payload_dt,
        )


def on_connect(client, userdata, flags, rc, properties=None):
    """
    Subscribe once the broker has accepted the connection.

    `properties` IS THE MQTT 5 SIGNATURE, and it is optional so the function is callable under
    either protocol -- paho passes five arguments for a v5 client and four for a 3.1.1 one. Keeping
    the default means this is not the thing that breaks if the protocol is ever moved back.

    `rc` is a `ReasonCodes` under v5 rather than an int, and `== 0` still works: paho's
    ReasonCodes.__eq__ compares against int. Verified against the pinned 1.6.1 rather than assumed,
    because a comparison that silently became False would leave the daemon connected and
    subscribed to nothing.
    """
    if rc == 0:
        logger.info("Connected to MQTT Broker successfully.")
        client.subscribe("spBv1.0/#")
        logger.info("Subscribed to 'spBv1.0/#'")
    else:
        logger.error("Failed to connect to MQTT Broker, return code %s", rc)


def on_disconnect(client, userdata, rc, properties=None):
    """
    Say that the connection ended, and say why WHEN THE LIBRARY GIVES US A WHY -- which, on the
    pinned paho, it does not for the case anyone cares about.

    BEFORE THIS THERE WAS NO on_disconnect AT ALL, so an involuntary disconnect was entirely silent
    and the only evidence was a "Connected to MQTT Broker successfully." arriving twice. That much
    is a real improvement and is why this exists.

    WHAT MQTT 5 WAS EXPECTED TO ADD, AND DOES NOT HERE. v5 lets the broker state a reason in its
    DISCONNECT, and mosquitto does: a session takeover, measured against this stack with mqtt.js,
    arrives as 142 `Session taken over`. paho 1.6.1 RECEIVES THAT PACKET AND DISCARDS THE REASON --
    `_handle_disconnect()` only decodes one when `remaining_length > 2`, and mosquitto's carries a
    reason code with zero-length properties, which is shorter than that. Enabling paho's protocol
    log against the same event shows it plainly:

        Received DISCONNECT None None

    and this callback is then reached with paho's own `MQTT_ERR_CONN_LOST` (7) instead. So the
    branch below that renders a `ReasonCodes` is not dead code -- a newer paho, or a broker sending
    properties, would take it -- but on the pinned version it does not fire, and claiming otherwise
    in a comment would be worse than not logging at all.

    IT IS A LOG LINE AND NOT A DECISION. paho's loop_forever() reconnects on its own and should:
    every reason a broker sends here is either transient or an operator's deliberate act, and a
    daemon that gave up on one would turn a reconnect into an outage.

    rc == 0 is a disconnect this daemon asked for, which is not worth a line.
    """
    if rc == 0:
        return

    # TWO DIFFERENT THINGS ARRIVE HERE AND CONFLATING THEM WOULD BE WORSE THAN NOT LOGGING.
    #
    #   a ReasonCodes  the BROKER said why -- it sent a DISCONNECT packet. This is the v5 gain:
    #                  "Session taken over", "Server shutting down", "Administrative action".
    #   a bare int     PAHO said why, and the broker said nothing. 7 is MQTT_ERR_CONN_LOST: the
    #                  socket went away. A hard broker restart looks like this, because the process
    #                  dies before it can send anything -- which is exactly the case v5 CANNOT
    #                  improve, and printing paho's number as though it were a protocol reason code
    #                  would misrepresent what was learned.
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
    Decode a Sparkplug B payload, falling back to the JSON encoding used by the
    Node-RED simulator flow. Returns None if the payload cannot be decoded.
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

            # The Sparkplug sequence number. Carried through so the fallback is not silently
            # blind to message loss -- check_message_sequence() tests HasField('seq'), and
            # dropping it here would make every JSON publisher exempt from gap detection.
            # Assigned only when present and integral: `seq` is a uint64, so a missing or
            # non-numeric one must leave the field unset rather than default it to 0, which
            # would read as a legitimate wrap and mask a real gap.
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

    The topic is authoritative; the Asset_ID metric is a cross-check, and is absent entirely
    from alias-encoded DDATA where the topic is the only identity available.

    THE STRICT CONTRACT APPLIES ONLY to devices already publishing a platform-issued id. A
    legacy device still publishing its name keeps "payload metric wins", so that gateways can
    be reconfigured one at a time. That arm is live -- it goes away with the rest of the
    name-matching fallback, not before.

    Resolution precedence: ../ingestion/README.md -> "Asset Identity on the Wire"
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

    # The Sparkplug Group ID. Carried through this call only, to scope the alias table and to
    # address a rebirth request back at the right node -- gateway and device resolution still
    # ignore it entirely, and no column stores it. Making the group part of an asset's identity
    # is a schema change and belongs with the rest of that work.
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


def _require_credentials():
    """
    Refuse to start without the broker and database credentials.

    Same posture as the Supabase check below, and for the same reason: these previously
    carried published defaults ("acscymru123" / "postgres"), so a deployment with the
    variable missing came up connected with a known-weak credential and reported nothing.
    A missing secret must be a startup failure, not a silent downgrade.
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

    Verification is always on and there is no switch to turn it off -- see the note on
    MQTT_TLS_CA_FILE. `cert_reqs=CERT_REQUIRED` is paho's default, and it is named here anyway so
    that the intent is legible at the call site rather than inherited.

    A CA file that is set but missing raises rather than falling back to the system store: with an
    internal CA the system store cannot verify the broker, so the fallback would fail at connect
    time instead, reporting a TLS handshake error that names neither this variable nor the path.
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
    # Hostname checking is what makes the certificate mean anything: without it any certificate
    # signed by the CA -- including one legitimately issued for a different service -- would be
    # accepted for the broker. paho leaves this on by default; it is set explicitly because
    # `tls_insecure_set(True)` is the single line that would silently undo this whole function.
    client.tls_insecure_set(False)
    logger.info(
        "MQTT TLS enabled; verifying the broker against %s",
        MQTT_TLS_CA_FILE or "the system trust store",
    )
    return True


def start_health_heartbeat(client):
    """
    Touch INGESTION_HEALTH_FILE every INGESTION_HEALTH_INTERVAL seconds while the MQTT connection
    is up, so an external prober can tell a live daemon from a wedged one.

    A daemon thread, so it can never hold the process open on shutdown. It is deliberately
    forgiving of write errors -- a full or read-only filesystem should stop the heartbeat (which
    correctly reports unhealthy) rather than crash a daemon that is otherwise ingesting fine.

    No-op when INGESTION_HEALTH_FILE is unset, which is the Compose default.
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

    A DAEMON THREAD OF ITS OWN, not a block inside start_health_heartbeat(), because that function
    returns immediately when INGESTION_HEALTH_FILE is unset -- the Docker Compose default. Counters
    reported from inside it would be invisible on the target where `docker logs` is the primary
    diagnostic.

    BOTH DELTA AND TOTAL ARE REPORTED. The delta is the interval's traffic, which is what answers
    "is the daemon keeping up"; the total is traffic since start, which is what answers "how much
    has it dropped today". A reporter emitting only one of them forces the reader to do arithmetic
    against a previous log line that may have scrolled.

    Counters with a zero delta AND a zero total are omitted, so a healthy line stays short and a
    drop counter appearing at all is itself the signal.
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


def start_metrics_endpoint():
    """
    Serve the counter registry in Prometheus exposition format (issues #22 and #24).

    `db_connected` IS READ AT SCRAPE TIME rather than tracked as a counter, because it is a state
    and not an event. `_ts_conn.closed` is psycopg2's own view: non-zero once the connection was
    closed on this side. It cannot see a connection dropped by the server -- that still reports 0
    and fails on first use -- so this gauge answers "did the daemon believe it had a connection",
    which is the honest question. `acs_ingestion_db_connect_failures_total` rising while this reads
    1 is the shape of a server-side drop.
    """
    if INGESTION_METRICS_PORT <= 0:
        # The policy decision lives here rather than in metrics.py, where port 0 means "ask the OS
        # for a free one" as it does everywhere else in the socket API.
        logger.info("Metrics endpoint disabled (INGESTION_METRICS_PORT=%s).", INGESTION_METRICS_PORT)
        return None

    def collect():
        # CACHE OCCUPANCY IS READ AT SCRAPE TIME for the same reason db_connected is: it is a
        # state, not an event. The evictions counter beside it is the one worth an alert -- a
        # non-zero value means MAX_ENTITIES_PER_CACHE is actually being reached, which is either a
        # fleet larger than the cap or the id churn the cap exists to absorb (issue #23). Until
        # the bound existed there was nothing to count and no way to see either.
        labelled = dict(labelled_snapshot())
        for cache in (_device_cache, _gateway_cache, _schema_cache):
            labelled[("acs_ingestion_cache_entries", (("cache", cache.name),))] = len(cache)
            labelled[("acs_ingestion_cache_evictions_total", (("cache", cache.name),))] = (
                cache.evictions
            )

        # APPLIANCE HEALTH, read at scrape time for the same reason the cache gauges are: these
        # are states rather than events. Four readings plus the timestamp that says how old they
        # are -- a gauge holds its last value indefinitely, so without that timestamp a dead
        # collector and a steady disk are the same picture.
        for edge_node, values in gateway_health_gauge_snapshot().items():
            for metric, value in values.items():
                labelled[(metric, (("edge_node", edge_node),))] = value

        return metrics.render_exposition(
            counters=counter_snapshot(),
            labelled=labelled,
            histograms=histogram_snapshot(),
            gauges={
                "acs_ingestion_up": 1,
                "acs_ingestion_db_connected":
                    1 if (_ts_conn is not None and not _ts_conn.closed) else 0,
            },
        )

    start_metrics_server(INGESTION_METRICS_PORT, collect, logger)


def main():
    logger.info("Initializing Supabase + TimescaleDB Ingestion Daemon...")
    _require_credentials()

    # BEFORE THE MQTT LOOP, so a misconfigured credential is a startup failure rather than
    # something discovered from the shape of the data months later.
    #
    # TWO KINDS OF FAILURE, AND THEY DESERVE OPPOSITE ANSWERS. A historian that is DOWN is a
    # transient fault this daemon is built to survive -- it warns per message, drops what it cannot
    # store, and resumes when the database returns, which is the right behaviour for a process
    # watching a plant. A historian that REFUSES THE CREDENTIAL is permanent: no amount of retrying
    # fixes a wrong password, and the daemon would run indefinitely discarding every reading while
    # logging `password authentication failed` once per message.
    #
    # That is not a hypothetical either -- it is what this stack did when the credential override
    # was introduced with only half of it settable. Nothing distinguished the two cases, so the
    # loud permanent fault wore the clothes of the quiet transient one.
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
        _startup_conn.close()
    if supabase_client is None:
        logger.critical(
            "CRITICAL SECURITY ERROR: Supabase client is uninitialized! SUPABASE_URL, "
            "SUPABASE_ANON_KEY or SUPABASE_INGESTION_KEY missing or invalid. "
            "SUPABASE_INGESTION_KEY replaced SUPABASE_SERVICE_ROLE_KEY here (see Machine Identities in supabase/README.md); an "
            ".env predating that change has no such key -- run scripts/setup.mjs, or copy it from "
            ".env.example for a demonstration stack. "
            "Ingestion daemon refusing to start MQTT loop in fail-open state. System halting to enforce fail-closed device quarantine gating."
        )
        raise SystemExit(1)

    # MQTT 5, and paho-mqtt==1.6.1's v1 callback API. Those are separate choices: the PROTOCOL is
    # v5 and the CALLBACK STYLE is still v1, which 1.6.1 supports. Upgrading to paho 2.x is what
    # would force CallbackAPIVersion.VERSION2, and that is a different change.
    #
    # WHAT v5 BUYS THIS DAEMON TODAY: nothing measurable, and that is recorded rather than
    # glossed. The broker's DISCONNECT reason code -- the one benefit that survived review -- is
    # sent by mosquitto and DISCARDED BY paho 1.6.1 before it reaches on_disconnect(); see the
    # measurement there. The daemon is on v5 because the platform is, and a stack speaking two
    # protocol versions is a combination nobody tests.
    client = mqtt.Client(protocol=mqtt.MQTTv5)
    client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    # Before connect(), necessarily: paho applies the TLS context when the socket is opened.
    configure_mqtt_tls(client)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message

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
    # Same reasoning, and it matters more here: a daemon stuck retrying the broker must still be
    # SCRAPEABLE, or the one condition worth alerting on is the one that takes the endpoint down
    # with it. `acs_ingestion_up` is 1 and every throughput counter is flat -- which is exactly
    # what "connected to nothing" looks like, and is distinguishable from a dead target.
    start_metrics_endpoint()

    while True:
        try:
            logger.info("Connecting to MQTT Broker at %s:%s...", MQTT_HOST, MQTT_PORT)
            # `clean_start=True` is v5's spelling of 3.1.1's clean_session, and it is passed
            # explicitly rather than left to paho's MQTT_CLEAN_START_FIRST_ONLY default so the
            # session semantics are the ones this daemon already had. NO SESSION EXPIRY
            # INTERVAL IS SET, deliberately: Sparkplug's NDEATH is the Last Will, and a
            # surviving session would delay it -- leaving dead edge nodes reading ONLINE with
            # every device beneath them apparently live.
            client.connect(MQTT_HOST, MQTT_PORT, 60, clean_start=True)
            break
        except Exception as e:
            logger.warning("MQTT Broker connection failed: %s. Retrying in 2 seconds...", e)
            time.sleep(2)

    client.loop_forever()

if __name__ == "__main__":
    main()
