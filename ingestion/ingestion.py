import os
import re
import time
import psycopg2
import paho.mqtt.client as mqtt
import sparkplug_b_pb2
from datetime import datetime, timezone
from logging_config import get_logger

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
DB_PASSWORD = os.getenv("DB_PASSWORD", "postgres")

# MQTT Broker configuration
MQTT_HOST = os.getenv("MQTT_HOST", "mosquitto")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
MQTT_USER = os.getenv("MQTT_USER", "factoryplus")
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD", "factoryplus123")

# Supabase configuration
SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

# -----------------------------------------------------------------------------
# Supabase Client Initialization
# -----------------------------------------------------------------------------
supabase_client = None
try:
    from supabase import create_client, Client
    if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
        supabase_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        logger.info("Supabase client initialized successfully.")
    else:
        logger.warning("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing. Supabase integration disabled.")
except Exception as e:
    logger.warning("Failed to initialize Supabase client: %s", e)

# -----------------------------------------------------------------------------
# TimescaleDB Connection Manager
# -----------------------------------------------------------------------------
_ts_conn = None

def get_timescaledb_connection():
    global _ts_conn
    if _ts_conn is None or _ts_conn.closed != 0:
        try:
            if TIMESCALEDB_URL:
                _ts_conn = psycopg2.connect(TIMESCALEDB_URL)
            else:
                _ts_conn = psycopg2.connect(
                    host=DB_HOST,
                    port=DB_PORT,
                    database=DB_NAME,
                    user=DB_USER,
                    password=DB_PASSWORD
                )
            logger.info("Connected to TimescaleDB successfully.")
        except Exception as e:
            logger.warning("TimescaleDB connection failed: %s. Retrying...", e)
            _ts_conn = None
    return _ts_conn

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

# Payload metrics that carry identity rather than configuration or telemetry. Asset_ID is the
# device's own claim about which asset it is (used only as a cross-check against the topic);
# Asset_Name is a human-readable hint. Neither is stored as a parameter or a metric.
IDENTITY_METRICS = ("Asset_ID", "Asset_Name")

# Recorded on devices.quarantine_reason as "<CODE>: <detail>".
REASON_UNKNOWN_DEVICE = "UNKNOWN_DEVICE"
REASON_MALFORMED_IDENTITY = "MALFORMED_IDENTITY"
REASON_IDENTITY_MISMATCH = "IDENTITY_MISMATCH"

# Recorded on devices.identity_source.
SOURCE_SPARKPLUG_ID = "sparkplug_id"
SOURCE_REPORTED_IDENTITY = "reported_identity"
SOURCE_LEGACY_NAME = "legacy_name"

# Device resolution TTL cache, keyed by the id seen on the wire.
# Values are (device_row_or_None, cached_at).
_device_cache = {}
_gateway_cache = {}
CACHE_TTL_SECONDS = 5

# Sparkplug B node-level (edge gateway) message types, as opposed to the device-level
# DBIRTH/DDATA/DDEATH. Their topics carry no device component.
NODE_MESSAGE_TYPES = ("NBIRTH", "NDATA", "NDEATH")

# Throttle for "unregistered edge node" warnings, keyed by edge node id.
_unknown_gateway_warned = {}
UNKNOWN_GATEWAY_WARN_INTERVAL_SECONDS = 300

# Throttle for legacy name-based identity deprecation warnings, keyed by the id on the wire.
_legacy_identity_warned = {}
LEGACY_IDENTITY_WARN_INTERVAL_SECONDS = 300

_DEVICE_COLUMNS = (
    "id,name,sparkplug_id,reported_identity,gateway_id,is_quarantined,first_dbirth_at,"
    "last_birth_metrics"
)


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


def resolve_device(wire_id: str, use_cache: bool = True):
    """
    Resolve an id seen on the wire to its `devices` row, in order of precedence:

      1. sparkplug_id      -- the platform-issued id, the current scheme.
      2. reported_identity -- a third-party device's own factory-preset id, recorded when it
                              was discovered. Such a device cannot be made to publish an
                              issued id, so its own is what must keep resolving.
      3. name              -- legacy, pre-0014 devices. Warns; this arm goes away once every
                              gateway has been reconfigured.

    Returns the row (with `_identity_source` attached) or None if unregistered. Any failure
    resolves to None, which callers treat as "quarantined" -- the fail-closed answer.
    """
    if not supabase_client:
        logger.warning("Supabase client unavailable. Failing closed: device '%s' assumed QUARANTINED.", wire_id)
        return None

    if use_cache and wire_id in _device_cache:
        row, cached_at = _device_cache[wire_id]
        if time.time() - cached_at < CACHE_TTL_SECONDS:
            return row

    # A well-formed platform id is never also a legacy name, so skip that round-trip.
    lookups = [("sparkplug_id", SOURCE_SPARKPLUG_ID), ("reported_identity", SOURCE_REPORTED_IDENTITY)]
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

            _device_cache[wire_id] = (row, time.time())
            return row

        _device_cache[wire_id] = (None, time.time())
        return None
    except Exception as e:
        # Not cached: a transient Supabase failure must not pin this device to "unregistered"
        # for the full TTL.
        logger.error("Error resolving device identity '%s' in Supabase: %s", wire_id, e)
        return None


def resolve_gateway(wire_id: str):
    """
    Resolve an edge node id to its `gateways` row by sparkplug_id, then by name (legacy).

    Gateways are never auto-created -- an unregistered edge node is logged and dropped,
    mirroring the fail-closed treatment of unregistered devices.
    """
    if not supabase_client or not wire_id:
        return None

    if wire_id in _gateway_cache:
        row, cached_at = _gateway_cache[wire_id]
        if time.time() - cached_at < CACHE_TTL_SECONDS:
            return row

    lookups = ["sparkplug_id"] if GATEWAY_ID_PATTERN.match(wire_id) else ["sparkplug_id", "name"]

    try:
        for column in lookups:
            res = supabase_client.table("gateways").select("id,name,sparkplug_id").eq(column, wire_id).execute()
            rows = res.data if res else []
            if not rows:
                continue

            row = dict(rows[0])
            row["_identity_source"] = SOURCE_SPARKPLUG_ID if column == "sparkplug_id" else SOURCE_LEGACY_NAME
            if column == "name" and _throttled(
                _legacy_identity_warned, wire_id, LEGACY_IDENTITY_WARN_INTERVAL_SECONDS
            ):
                logger.warning(
                    "DEPRECATED IDENTITY: edge node '%s' was matched by name. Reconfigure it to publish "
                    "sparkplug_id '%s' instead; name-based matching will be removed.",
                    wire_id, row.get("sparkplug_id")
                )

            _gateway_cache[wire_id] = (row, time.time())
            return row

        _gateway_cache[wire_id] = (None, time.time())
        return None
    except Exception as e:
        logger.error("Error resolving gateway identity '%s' in Supabase: %s", wire_id, e)
        return None

# -----------------------------------------------------------------------------
# Sparkplug B Ingestion Handlers
# -----------------------------------------------------------------------------
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

        row = {
            "asset_id": sparkplug_id,
            "metric_name": metric.name,
            "val_double": None,
            "val_string": None,
            "val_bool": None,
            "datatype": metric.datatype if metric.HasField("datatype") else None,
            "updated_at": datetime.now(timezone.utc).isoformat()
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
        # so a re-birth refreshes values instead of accumulating duplicates.
        supabase_client.table("asset_config").upsert(
            rows, on_conflict="asset_id,metric_name"
        ).execute()
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
        supabase_client.table("devices").update({
            "last_birth_metrics": declared,
            "last_birth_metrics_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", device["id"]).execute()

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


def quarantine_new_device(wire_id: str, gateway_wire_id: str, reason: str, payload):
    """
    Insert a newly discovered device with is_quarantined = True, and return the created row.

    The arriving edge node is recorded on the row. Ingestion has always had it in scope and
    always discarded it, which is why approving a quarantined device previously required the
    operator to re-pick its gateway by hand.
    """
    gateway = resolve_gateway(gateway_wire_id)
    if gateway is None:
        logger.warning(
            "Quarantining device '%s' from unregistered edge node '%s': it will have no gateway "
            "assigned until one is chosen at approval.", wire_id, gateway_wire_id
        )

    now = datetime.now(timezone.utc).isoformat()
    record = {
        "name": extract_name_hint(payload) or wire_id,
        "status": "ONLINE",
        "is_quarantined": True,
        "first_dbirth_at": now,
        "reported_identity": wire_id,
        "quarantine_reason": reason,
        "identity_source": SOURCE_REPORTED_IDENTITY,
        "gateway_id": gateway["id"] if gateway else None,
        # Carried on the INSERT rather than left to record_declared_metrics' UPDATE, so a newly
        # discovered device produces one digital_thread entry instead of an insert immediately
        # chased by an update saying the same thing.
        "last_birth_metrics": extract_declared_metrics(payload),
        "last_birth_metrics_at": now,
    }

    res = supabase_client.table("devices").insert(record).execute()
    rows = res.data if res else []
    row = dict(rows[0]) if rows else None

    # sparkplug_id is a generated column, so it comes back in the returned representation.
    # If the client was configured not to return one, resolve it rather than guessing.
    if row and not row.get("sparkplug_id"):
        row = resolve_device(wire_id, use_cache=False)
    if row:
        row["_identity_source"] = SOURCE_REPORTED_IDENTITY
        _device_cache[wire_id] = (row, time.time())

    logger.warning(
        "QUARANTINE ALERT: device '%s' announced DBIRTH via edge node '%s' but is not registered. "
        "Inserted with is_quarantined=True (%s).", wire_id, gateway_wire_id, reason
    )
    return row


def process_dbirth(wire_id: str, gateway_wire_id: str, payload, quarantine_reason: str = None):
    """
    On Sparkplug B DBIRTH:
    Resolve the device by its wire identity. If it is unregistered, insert it quarantined,
    recording both the id it published under and why it was held.
    Birth certificate metrics are recorded to `asset_config` either way.

    `quarantine_reason` is supplied by the caller when the identity itself was already found
    to be faulty (malformed, or contradicting the payload's Asset_ID claim). Such a device is
    still admitted to the queue rather than dropped -- silently discarding it would make a
    misconfigured gateway invisible instead of diagnosable.
    """
    logger.info("Processing DBIRTH for device '%s' via edge node '%s'", wire_id, gateway_wire_id)
    if not supabase_client:
        logger.warning("Supabase client unavailable. Skipping Supabase DBIRTH check for '%s'", wire_id)
        return

    try:
        device = resolve_device(wire_id, use_cache=False)

        if device is None:
            device = quarantine_new_device(
                wire_id, gateway_wire_id, quarantine_reason or REASON_UNKNOWN_DEVICE, payload
            )
            if device is None:
                logger.error("Failed to record quarantined device '%s'; dropping its birth certificate.", wire_id)
                return
        elif device.get("is_quarantined"):
            logger.warning("QUARANTINE NOTICE: DBIRTH received for quarantined device '%s'", device.get("name"))
        elif quarantine_reason:
            # A registered device that has started publishing a faulty identity. Re-quarantine
            # it: whatever is on the wire no longer reliably identifies this asset.
            supabase_client.table("devices").update({
                "is_quarantined": True,
                "quarantine_reason": quarantine_reason,
                "reported_identity": wire_id,
            }).eq("id", device["id"]).execute()
            _device_cache.pop(wire_id, None)
            logger.warning(
                "QUARANTINE ALERT: registered device '%s' published a faulty identity and was "
                "re-quarantined (%s).", device.get("name"), quarantine_reason
            )
        else:
            # first_dbirth_at is write-once: only set it the first time this row sees a
            # real birth, so a later rebirth never overwrites the original timestamp.
            update_fields = {"status": "ONLINE", "identity_source": device["_identity_source"]}
            if not device.get("first_dbirth_at"):
                update_fields["first_dbirth_at"] = datetime.now(timezone.utc).isoformat()
            supabase_client.table("devices").update(update_fields).eq("id", device["id"]).execute()
            logger.info("DBIRTH: verified registered device '%s' (%s)", device.get("name"), wire_id)

        # Both run for quarantined devices too: they record what the device *claims*, which is
        # exactly what an administrator needs to inspect before approving it. DDATA telemetry
        # stays gated.
        store_birth_parameters(device["sparkplug_id"], payload)
        record_declared_metrics(device, payload)
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

    device = resolve_device(wire_id)
    if device is None:
        logger.warning("DDEATH received for unregistered device '%s'; nothing to update", wire_id)
        return

    try:
        supabase_client.table("devices").update({"status": "OFFLINE"}).eq("id", device["id"]).execute()
    except Exception as e:
        logger.error("Error applying DDEATH status update for '%s': %s", wire_id, e, exc_info=True)


def process_node_message(edge_node_id: str, msg_type: str, payload):
    """
    On Sparkplug B node-level messages (NBIRTH / NDATA / NDEATH):
    Update the matching `gateways` row's status and last_heartbeat in Supabase.

    NBIRTH/NDATA mark the edge node ONLINE; NDEATH marks it OFFLINE. A `Gateway_Status`
    string metric in the payload (what node_red_flow.json publishes) overrides the
    status derived from the message type.

    Gateways are never auto-created: an unregistered edge node is logged and dropped,
    mirroring the fail-closed treatment of unregistered devices.
    """
    if not supabase_client:
        logger.warning("Supabase client unavailable. Dropping %s heartbeat for edge node '%s'", msg_type, edge_node_id)
        return

    status = "OFFLINE" if msg_type == "NDEATH" else "ONLINE"
    for metric in payload.metrics:
        if metric.name in ("Gateway_Status", "Node_Status") and metric.HasField("string_value"):
            status = metric.string_value
            break

    # Receipt time, not the payload timestamp: staleness is judged against this server's
    # clock, and edge node clocks drift (or, for a replayed payload, are plain wrong).
    heartbeat_dt = datetime.now(timezone.utc)

    gateway = resolve_gateway(edge_node_id)
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

    try:
        supabase_client.table("gateways").update({
            "status": status,
            "last_heartbeat": heartbeat_dt.isoformat()
        }).eq("id", gateway["id"]).execute()

        logger.info(
            "HEARTBEAT: %s from edge node '%s' (%s) -> status=%s at %s",
            msg_type, gateway.get("name"), edge_node_id, status, heartbeat_dt.isoformat()
        )
    except Exception as e:
        logger.error("Error updating gateway heartbeat for '%s': %s", edge_node_id, e, exc_info=True)


def process_ddata(wire_id: str, gateway_wire_id: str, payload):
    """
    On Sparkplug B DDATA:
    Verify device registration & quarantine status in Supabase.
    If quarantined or missing, drop DDATA telemetry.
    Otherwise, insert metric timestamps and values into TimescaleDB telemetry hypertable,
    keyed by the device's immutable `sparkplug_id` so a rename never breaks the series.
    """
    device = resolve_device(wire_id)
    if device is None or device.get("is_quarantined"):
        logger.warning("Dropping DDATA for quarantined/unregistered device '%s'", wire_id)
        return

    asset_id = device["sparkplug_id"]
    asset_name = device.get("name") or asset_id

    db_conn = get_timescaledb_connection()
    if not db_conn:
        logger.warning("TimescaleDB connection unavailable. Skipping DDATA telemetry ingestion for '%s'", wire_id)
        return

    payload_ts = payload.timestamp if hasattr(payload, 'timestamp') and payload.timestamp > 0 else int(time.time() * 1000)
    payload_dt = datetime.fromtimestamp(payload_ts / 1000.0, timezone.utc)

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

                metric_count = 0
                for metric in payload.metrics:
                    if metric.name in IDENTITY_METRICS:
                        continue

                    if metric.HasField('timestamp') and metric.timestamp > 0:
                        metric_dt = datetime.fromtimestamp(metric.timestamp / 1000.0, timezone.utc)
                    else:
                        metric_dt = payload_dt

                    val_double = None
                    val_string = None
                    val_bool = None

                    if metric.HasField("int_value"):
                        val_double = float(metric.int_value)
                    elif metric.HasField("long_value"):
                        val_double = float(metric.long_value)
                    elif metric.HasField("float_value"):
                        val_double = float(metric.float_value)
                    elif metric.HasField("double_value"):
                        val_double = metric.double_value
                    elif metric.HasField("boolean_value"):
                        val_bool = metric.boolean_value
                    elif metric.HasField("string_value"):
                        val_string = metric.string_value
                    else:
                        continue

                    cur.execute(
                        """
                        INSERT INTO telemetry (time, asset_id, metric_name, val_double, val_string, val_bool)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (time, asset_id, metric_name) DO UPDATE SET
                            val_double = EXCLUDED.val_double,
                            val_string = EXCLUDED.val_string,
                            val_bool = EXCLUDED.val_bool
                        """,
                        (metric_dt, asset_id, metric.name, val_double, val_string, val_bool)
                    )
                    metric_count += 1

                logger.info("INGESTED DDATA: Ingested %d metrics for asset '%s' into TimescaleDB", metric_count, asset_id)
    except Exception as e:
        logger.error("Error writing DDATA telemetry to TimescaleDB: %s", e, exc_info=True)


def on_connect(client, userdata, flags, rc):
    if rc == 0:
        logger.info("Connected to MQTT Broker successfully.")
        client.subscribe("spBv1.0/#")
        logger.info("Subscribed to 'spBv1.0/#'")
    else:
        logger.error("Failed to connect to MQTT Broker, return code %s", rc)


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

            for m in data.get('metrics', []):
                metric = payload.metrics.add()
                metric.name = m.get('name', '')
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

    The topic is authoritative. The Asset_ID metric used to silently override it, which meant
    a device could publish under one id and be tracked as another -- and it is absent entirely
    from alias-encoded DDATA, where the topic is the only identity available.

    The strict contract is applied only to devices already publishing a platform-issued id.
    A legacy device still publishing its name keeps the old "payload metric wins" behaviour so
    that reconfiguring gateways one at a time stays non-breaking; that arm goes away with the
    rest of the name-matching fallback.
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

    msg_type = parts[2]
    edge_node_id = parts[3]

    if not msg.payload:
        return

    payload = parse_sparkplug_payload(msg)
    if payload is None:
        return

    # Node-level topics (spBv1.0/<group>/<NBIRTH|NDATA|NDEATH>/<edge_node>) carry no
    # device component and no Asset_ID metric -- they are edge gateway heartbeats.
    if msg_type in NODE_MESSAGE_TYPES and len(parts) < 5:
        process_node_message(edge_node_id, msg_type, payload)
        return

    wire_id, quarantine_reason = resolve_wire_identity(parts, payload)
    if not wire_id:
        return

    if msg_type in ("DBIRTH", "NBIRTH"):
        process_dbirth(wire_id, edge_node_id, payload, quarantine_reason)
    elif msg_type == "DDATA":
        if quarantine_reason:
            # Faulty identity: the birth path is what records it for the operator. Telemetry
            # from an asset we cannot reliably identify must not reach the historian.
            logger.warning("Dropping DDATA from device '%s': %s", wire_id, quarantine_reason)
            return
        process_ddata(wire_id, edge_node_id, payload)
    elif msg_type == "DDEATH":
        process_ddeath(wire_id, edge_node_id)
    else:
        logger.info("Received %s message for device '%s' via edge node '%s'", msg_type, wire_id, edge_node_id)


def main():
    logger.info("Initializing Supabase + TimescaleDB Ingestion Daemon...")
    if supabase_client is None:
        logger.critical(
            "CRITICAL SECURITY ERROR: Supabase client is uninitialized! SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing or invalid. "
            "Ingestion daemon refusing to start MQTT loop in fail-open state. System halting to enforce fail-closed device quarantine gating."
        )
        raise SystemExit(1)

    # Note: Intentionally using paho-mqtt==1.6.1 v1 callback signatures.
    # If upgrading to paho-mqtt 2.x+, callbacks must be migrated to CallbackAPIVersion.VERSION2
    # signatures (e.g. on_connect(client, userdata, flags, reason_code, properties)).
    client = mqtt.Client()
    client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    client.on_connect = on_connect
    client.on_message = on_message

    while True:
        try:
            logger.info("Connecting to MQTT Broker at %s:%s...", MQTT_HOST, MQTT_PORT)
            client.connect(MQTT_HOST, MQTT_PORT, 60)
            break
        except Exception as e:
            logger.warning("MQTT Broker connection failed: %s. Retrying in 2 seconds...", e)
            time.sleep(2)

    client.loop_forever()

if __name__ == "__main__":
    main()
