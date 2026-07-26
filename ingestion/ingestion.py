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
# Sparkplug B Ingestion Handlers
# -----------------------------------------------------------------------------
def process_dbirth(asset_id: str, gateway_id: str, payload):
    """
    On Sparkplug B DBIRTH:
    Check if device exists in Supabase `devices` table.
    If missing, insert a new record with is_quarantined = True and trigger quarantine alert log.
    """
    logger.info("Processing DBIRTH for device '%s' via gateway '%s'", asset_id, gateway_id)
    if not supabase_client:
        logger.warning("Supabase client unavailable. Skipping Supabase DBIRTH check for '%s'", asset_id)
        return

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
            logger.warning(
                "QUARANTINE ALERT: Device '%s' announced DBIRTH but was missing from Supabase 'devices' table. "
                "Inserted new record with is_quarantined=True.", asset_id
            )
        else:
            dev = devices[0]
            if dev.get("is_quarantined"):
                logger.warning("QUARANTINE NOTICE: DBIRTH received for quarantined device '%s'", asset_id)
            else:
                supabase_client.table("devices").update({"status": "ONLINE"}).eq("id", dev["id"]).execute()
                logger.info("DBIRTH: Verified registered device '%s' in Supabase", asset_id)
    except Exception as e:
        logger.error("Error checking/updating Supabase devices for DBIRTH: %s", e, exc_info=True)


def process_ddata(asset_id: str, gateway_id: str, payload):
    """
    On Sparkplug B DDATA:
    Insert metric timestamps and values into TimescaleDB telemetry hypertable.
    """
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


def on_message(client, userdata, msg):
    parts = msg.topic.split('/')
    if len(parts) < 4 or parts[0] != 'spBv1.0':
        return

    msg_type = parts[2]
    gateway_id = parts[3]

    if not msg.payload:
        return

    payload = sparkplug_b_pb2.Payload()
    try:
        payload.ParseFromString(msg.payload)
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
        except Exception as json_err:
            logger.warning("Failed to decode Sparkplug B payload on topic %s: %s", msg.topic, pb_err)
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
    else:
        logger.info("Received %s message for asset '%s' via gateway '%s'", msg_type, asset_id, gateway_id)


def main():
    logger.info("Initializing Supabase + TimescaleDB Ingestion Daemon...")

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
