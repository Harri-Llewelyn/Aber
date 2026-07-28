import os
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
# Quarantine Status In-Process TTL Cache
# -----------------------------------------------------------------------------
_quarantine_cache = {}
CACHE_TTL_SECONDS = 5

# Sparkplug B node-level (edge gateway) message types, as opposed to the device-level
# DBIRTH/DDATA/DDEATH. Their topics carry no device component.
NODE_MESSAGE_TYPES = ("NBIRTH", "NDATA", "NDEATH")

# Throttle for "unregistered edge node" warnings, keyed by edge node id.
_unknown_gateway_warned = {}
UNKNOWN_GATEWAY_WARN_INTERVAL_SECONDS = 300

def is_device_quarantined(asset_id: str) -> bool:
    """
    Checks if a device is quarantined or unregistered in Supabase.
    Returns True if the device is missing from Supabase OR if is_quarantined is True.
    Returns False ONLY if the device exists in Supabase and is_quarantined is False.
    Caches results for CACHE_TTL_SECONDS to avoid excessive Supabase round-trips.
    """
    if not supabase_client:
        logger.warning("Supabase client unavailable. Failing closed: device '%s' assumed QUARANTINED.", asset_id)
        return True

    now = time.time()
    if asset_id in _quarantine_cache:
        is_quarantined, cached_at = _quarantine_cache[asset_id]
        if now - cached_at < CACHE_TTL_SECONDS:
            return is_quarantined

    try:
        res = supabase_client.table("devices").select("is_quarantined").eq("name", asset_id).execute()
        devices = res.data if res else []
        if not devices:
            is_quarantined = True
        else:
            is_quarantined = bool(devices[0].get("is_quarantined"))

        _quarantine_cache[asset_id] = (is_quarantined, now)
        return is_quarantined
    except Exception as e:
        logger.error("Error checking device quarantine status in Supabase for '%s': %s", asset_id, e)
        return True

# -----------------------------------------------------------------------------
# Sparkplug B Ingestion Handlers
# -----------------------------------------------------------------------------
def store_birth_parameters(asset_id: str, payload):
    """
    Persist the metrics carried by a DBIRTH birth certificate to `asset_config`, so the
    dashboard's device Config view can show the parameters the device announced
    (firmware version, serial number, thresholds, interlocks...).

    These are configuration parameters, not telemetry: they are stored for quarantined
    devices too, precisely so an administrator can inspect what a newly discovered
    device claims about itself *before* approving it. DDATA telemetry stays gated.
    """
    if not supabase_client:
        return

    rows = []
    for metric in payload.metrics:
        if not metric.name or metric.name == 'Asset_ID':
            continue

        row = {
            "asset_id": asset_id,
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
        logger.info("DBIRTH: Stored %d birth parameters for device '%s'", len(rows), asset_id)
    except Exception as e:
        logger.error("Error storing DBIRTH parameters for '%s': %s", asset_id, e, exc_info=True)


def process_dbirth(asset_id: str, gateway_id: str, payload):
    """
    On Sparkplug B DBIRTH:
    Check if device exists in Supabase `devices` table.
    If missing, insert a new record with is_quarantined = True and trigger quarantine alert log.
    Birth certificate metrics are recorded to `asset_config` either way.
    """
    logger.info("Processing DBIRTH for device '%s' via gateway '%s'", asset_id, gateway_id)
    if not supabase_client:
        logger.warning("Supabase client unavailable. Skipping Supabase DBIRTH check for '%s'", asset_id)
        return

    store_birth_parameters(asset_id, payload)

    try:
        res = supabase_client.table("devices").select("*").eq("name", asset_id).execute()
        devices = res.data if res else []

        if not devices:
            # Device missing -> Insert with is_quarantined = True
            supabase_client.table("devices").insert({
                "name": asset_id,
                "status": "ONLINE",
                "is_quarantined": True
            }).execute()
            _quarantine_cache[asset_id] = (True, time.time())
            logger.warning(
                "QUARANTINE ALERT: Device '%s' announced DBIRTH but was missing from Supabase 'devices' table. "
                "Inserted new record with is_quarantined=True.", asset_id
            )
        else:
            dev = devices[0]
            is_quar = bool(dev.get("is_quarantined"))
            _quarantine_cache[asset_id] = (is_quar, time.time())
            if is_quar:
                logger.warning("QUARANTINE NOTICE: DBIRTH received for quarantined device '%s'", asset_id)
            else:
                supabase_client.table("devices").update({"status": "ONLINE"}).eq("id", dev["id"]).execute()
                logger.info("DBIRTH: Verified registered device '%s' in Supabase", asset_id)
    except Exception as e:
        logger.error("Error checking/updating Supabase devices for DBIRTH: %s", e, exc_info=True)


def process_ddeath(asset_id: str, gateway_id: str):
    """
    On Sparkplug B DDEATH: mark the registered device OFFLINE in Supabase so the
    dashboard's "OFFLINE / DDEATH" state reflects the actual death certificate.
    """
    logger.info("Processing DDEATH for device '%s' via gateway '%s'", asset_id, gateway_id)
    if not supabase_client:
        logger.warning("Supabase client unavailable. Skipping DDEATH status update for '%s'", asset_id)
        return

    try:
        res = supabase_client.table("devices").update({"status": "OFFLINE"}).eq("name", asset_id).execute()
        if not res.data:
            logger.warning("DDEATH received for unregistered device '%s'; nothing to update", asset_id)
    except Exception as e:
        logger.error("Error applying DDEATH status update for '%s': %s", asset_id, e, exc_info=True)


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

    try:
        res = supabase_client.table("gateways").update({
            "status": status,
            "last_heartbeat": heartbeat_dt.isoformat()
        }).eq("name", edge_node_id).execute()

        if res.data:
            logger.info(
                "HEARTBEAT: %s from edge node '%s' -> status=%s at %s",
                msg_type, edge_node_id, status, heartbeat_dt.isoformat()
            )
        else:
            # Rate-limited: an unregistered node beats every 30s and would otherwise
            # fill the log with the same line forever.
            now = time.time()
            last_warned = _unknown_gateway_warned.get(edge_node_id, 0)
            if now - last_warned > UNKNOWN_GATEWAY_WARN_INTERVAL_SECONDS:
                _unknown_gateway_warned[edge_node_id] = now
                logger.warning(
                    "Received %s from unregistered edge node '%s'. Register a gateway with this "
                    "exact name to track its heartbeat.", msg_type, edge_node_id
                )
    except Exception as e:
        logger.error("Error updating gateway heartbeat for '%s': %s", edge_node_id, e, exc_info=True)


def process_ddata(asset_id: str, gateway_id: str, payload):
    """
    On Sparkplug B DDATA:
    Verify device registration & quarantine status in Supabase.
    If quarantined or missing, drop DDATA telemetry.
    Otherwise, insert metric timestamps and values into TimescaleDB telemetry hypertable.
    """
    if is_device_quarantined(asset_id):
        logger.warning("Dropping DDATA for quarantined/unregistered device '%s'", asset_id)
        return

    db_conn = get_timescaledb_connection()
    if not db_conn:
        logger.warning("TimescaleDB connection unavailable. Skipping DDATA telemetry ingestion for '%s'", asset_id)
        return

    payload_ts = payload.timestamp if hasattr(payload, 'timestamp') and payload.timestamp > 0 else int(time.time() * 1000)
    payload_dt = datetime.fromtimestamp(payload_ts / 1000.0, timezone.utc)

    try:
        with db_conn:
            with db_conn.cursor() as cur:
                # Ensure asset entry exists in TimescaleDB assets table to satisfy foreign key constraint
                cur.execute(
                    "INSERT INTO assets (asset_id, asset_name) VALUES (%s, %s) ON CONFLICT (asset_id) DO NOTHING;",
                    (asset_id, asset_id)
                )

                metric_count = 0
                for metric in payload.metrics:
                    if metric.name == 'Asset_ID':
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


def on_message(client, userdata, msg):
    parts = msg.topic.split('/')
    if len(parts) < 4 or parts[0] != 'spBv1.0':
        return

    msg_type = parts[2]
    gateway_id = parts[3]

    if not msg.payload:
        return

    payload = parse_sparkplug_payload(msg)
    if payload is None:
        return

    # Node-level topics (spBv1.0/<group>/<NBIRTH|NDATA|NDEATH>/<edge_node>) carry no
    # device component and no Asset_ID metric -- they are edge gateway heartbeats.
    if msg_type in NODE_MESSAGE_TYPES and len(parts) < 5:
        process_node_message(gateway_id, msg_type, payload)
        return

    asset_id = None
    for metric in payload.metrics:
        if metric.name == 'Asset_ID':
            if metric.HasField('string_value'):
                asset_id = metric.string_value
            elif metric.HasField('int_value'):
                asset_id = str(metric.int_value)
            elif metric.HasField('long_value'):
                asset_id = str(metric.long_value)
            break

    if not asset_id and len(parts) >= 5:
        asset_id = parts[4]

    if not asset_id:
        return

    if msg_type in ("DBIRTH", "NBIRTH"):
        process_dbirth(asset_id, gateway_id, payload)
    elif msg_type == "DDATA":
        process_ddata(asset_id, gateway_id, payload)
    elif msg_type == "DDEATH":
        process_ddeath(asset_id, gateway_id)
    else:
        logger.info("Received %s message for asset '%s' via gateway '%s'", msg_type, asset_id, gateway_id)


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
