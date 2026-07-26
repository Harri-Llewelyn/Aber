import os
import sys
import time
import argparse
import psycopg2
import paho.mqtt.client as mqtt
import sparkplug_b_pb2
from datetime import datetime, timezone, timedelta

# Configuration
TIMESCALEDB_HOST = os.getenv("DB_HOST", "localhost")
TIMESCALEDB_PORT = os.getenv("DB_PORT", "5433" if os.getenv("DB_HOST") is None else "5432")
TIMESCALEDB_NAME = os.getenv("DB_NAME", "postgres")
TIMESCALEDB_USER = os.getenv("DB_USER", "postgres")
TIMESCALEDB_PASS = os.getenv("DB_PASSWORD", "postgres")

MQTT_HOST = os.getenv("MQTT_HOST", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJzZXJ2aWNlX3JvbGUiLCJleHAiOjIwMDAwMDAwMDB9.GWSHLKn253lfP0FAYobjuXvQkQGcYhKVJ6Y0IJOo-lA")

# Identifiers for validation
VAL_CELL_NAME = "VALIDATE Cell 1"
VAL_GW_NAME = "VALIDATE_Gateway_01"
VAL_KNOWN_DEVICE = "VALIDATE_Device_001"
VAL_QUARANTINE_DEVICE = "VALIDATE_Quarantine_Device_001"

supabase_client = None
try:
    from supabase import create_client
    supabase_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
except Exception as e:
    print(f"Warning: Supabase client init failed: {e}")

def get_timescaledb_connection():
    return psycopg2.connect(
        host=TIMESCALEDB_HOST,
        port=TIMESCALEDB_PORT,
        database=TIMESCALEDB_NAME,
        user=TIMESCALEDB_USER,
        password=TIMESCALEDB_PASS
    )

def cleanup_validation_data():
    print("Cleaning up validation data...")
    if supabase_client:
        try:
            supabase_client.table("devices").delete().like("name", "VALIDATE_%").execute()
            supabase_client.table("gateways").delete().like("name", "VALIDATE_%").execute()
            supabase_client.table("cells").delete().eq("name", VAL_CELL_NAME).execute()
            supabase_client.table("digital_thread").delete().like("entity_type", "%VALIDATE%").execute()
        except Exception as e:
            print(f"Supabase cleanup warning: {e}")

    try:
        conn = get_timescaledb_connection()
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute("DELETE FROM telemetry WHERE asset_id LIKE 'VALIDATE_%';")
        cur.execute("DELETE FROM assets WHERE asset_id LIKE 'VALIDATE_%';")
        conn.close()
    except Exception as e:
        print(f"TimescaleDB cleanup warning: {e}")

    print("Cleanup complete.")

def make_sparkplug_payload(asset_id, metrics_dict, timestamp_ms):
    payload = sparkplug_b_pb2.Payload()
    payload.timestamp = timestamp_ms

    m_asset = payload.metrics.add()
    m_asset.name = "Asset_ID"
    m_asset.string_value = asset_id
    m_asset.datatype = 12

    for name, val in metrics_dict.items():
        m = payload.metrics.add()
        m.name = name
        m.timestamp = timestamp_ms

        if isinstance(val, bool):
            m.boolean_value = val
            m.datatype = 11
        elif isinstance(val, (int, float)):
            m.double_value = float(val)
            m.datatype = 10
        elif isinstance(val, str):
            m.string_value = val
            m.datatype = 12

    return payload.SerializeToString()

def seed_supabase():
    print("Seeding Supabase test metadata (cells, gateways, registered device)...")
    if not supabase_client:
        print("Skipping Supabase seed: client unavailable")
        return

    # Seed cell
    c_res = supabase_client.table("cells").insert({"name": VAL_CELL_NAME}).execute()
    cell_id = c_res.data[0]["id"] if c_res.data else None

    # Seed gateway
    g_res = supabase_client.table("gateways").insert({"name": VAL_GW_NAME, "cell_id": cell_id, "status": "ONLINE"}).execute()
    gw_id = g_res.data[0]["id"] if g_res.data else None

    # Seed known registered device
    supabase_client.table("devices").insert({
        "name": VAL_KNOWN_DEVICE,
        "gateway_id": gw_id,
        "status": "ONLINE",
        "is_quarantined": False
    }).execute()

    print("Supabase test metadata seeded successfully.")

def run_simulation():
    print("Connecting validation publisher to MQTT broker...")
    # Note: Intentionally using paho-mqtt==1.6.1 v1 callback signatures.
    # If upgrading to paho-mqtt 2.x+, callbacks must be migrated to CallbackAPIVersion.VERSION2
    # signatures (e.g. on_connect(client, userdata, flags, reason_code, properties)).
    client = mqtt.Client()
    client.username_pw_set(os.getenv("MQTT_USER", "factoryplus"), os.getenv("MQTT_PASSWORD", "factoryplus123"))
    
    connected = False
    for attempt in range(5):
        try:
            client.connect(MQTT_HOST, MQTT_PORT, 60)
            connected = True
            break
        except Exception as e:
            print(f"MQTT connect attempt {attempt+1} failed: {e}. Retrying...")
            time.sleep(2)

    if not connected:
        print("Failed to connect to MQTT broker.")
        return

    client.loop_start()

    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

    # 1. DBIRTH for unknown device -> should create quarantined device in Supabase
    print(f"\n--- Simulating DBIRTH for unknown device: {VAL_QUARANTINE_DEVICE} ---")
    payload_birth = make_sparkplug_payload(VAL_QUARANTINE_DEVICE, {"firmware": "v1.0.0"}, now_ms)
    client.publish(f"spBv1.0/Group1/DBIRTH/{VAL_GW_NAME}/Device1", payload_birth)
    time.sleep(2)

    # 2. DDATA for quarantined device -> should be gated and NOT written to TimescaleDB
    print(f"\n--- Simulating DDATA telemetry for quarantined device: {VAL_QUARANTINE_DEVICE} ---")
    payload_quarantine_ddata = make_sparkplug_payload(VAL_QUARANTINE_DEVICE, {"temperature": 99.9, "status": "QUARANTINED"}, now_ms)
    client.publish(f"spBv1.0/Group1/DDATA/{VAL_GW_NAME}/Device1", payload_quarantine_ddata)
    time.sleep(2)

    # 3. DDATA for registered device -> should insert metrics into TimescaleDB
    print(f"\n--- Simulating DDATA telemetry for registered device: {VAL_KNOWN_DEVICE} ---")
    payload_ddata = make_sparkplug_payload(VAL_KNOWN_DEVICE, {"temperature": 42.5, "status": "RUNNING", "safety_ok": True}, now_ms)
    client.publish(f"spBv1.0/Group1/DDATA/{VAL_GW_NAME}/Device1", payload_ddata)
    time.sleep(2)

    client.loop_stop()
    client.disconnect()

def verify_results():
    print("\n==========================================")
    print("    END-TO-END VALIDATION REPORT")
    print("==========================================")
    passed = True

    # 1. Verify Supabase device quarantine logic
    if supabase_client:
        try:
            res = supabase_client.table("devices").select("*").eq("name", VAL_QUARANTINE_DEVICE).execute()
            devices = res.data if res else []
            if devices and devices[0].get("is_quarantined") is True:
                print("✅ 1. SUPABASE QUARANTINE: Unknown device DBIRTH correctly auto-inserted with is_quarantined = True.")
            else:
                print(f"❌ 1. SUPABASE QUARANTINE FAIL: Device '{VAL_QUARANTINE_DEVICE}' missing or is_quarantined is not True.")
                passed = False
        except Exception as e:
            print(f"❌ 1. SUPABASE QUARANTINE ERROR: {e}")
            passed = False

        # 2. Verify Digital Thread triggers
        try:
            res_thread = supabase_client.table("digital_thread").select("*").execute()
            logs = res_thread.data if res_thread else []
            if len(logs) > 0:
                print(f"✅ 2. DIGITAL THREAD TRIGGERS: Found {len(logs)} automated PostgreSQL audit trigger entries in digital_thread.")
            else:
                print("❌ 2. DIGITAL THREAD TRIGGERS FAIL: No trigger log entries found in digital_thread table.")
                passed = False
        except Exception as e:
            print(f"❌ 2. DIGITAL THREAD TRIGGERS ERROR: {e}")
            passed = False
    else:
        print("⚠️  Skipping Supabase API checks: client unavailable.")

    # 3. Verify TimescaleDB telemetry hypertable for registered device
    try:
        conn = get_timescaledb_connection()
        cur = conn.cursor()
        cur.execute("SELECT metric_name, val_double, val_string, val_bool FROM telemetry WHERE asset_id = %s;", (VAL_KNOWN_DEVICE,))
        rows = cur.fetchall()
        if len(rows) > 0:
            print(f"✅ 3. TIMESCALEDB TELEMETRY: Successfully ingested {len(rows)} telemetry metrics for '{VAL_KNOWN_DEVICE}'.")
            for r in rows:
                print(f"      -> Metric: {r[0]:<15} double={r[1]} string={r[2]} bool={r[3]}")
        else:
            print(f"❌ 3. TIMESCALEDB TELEMETRY FAIL: No telemetry records found for '{VAL_KNOWN_DEVICE}'.")
            passed = False
        conn.close()
    except Exception as e:
        print(f"❌ 3. TIMESCALEDB TELEMETRY ERROR: {e}")
        passed = False

    # 4. Verify telemetry gating for quarantined device
    try:
        conn = get_timescaledb_connection()
        cur = conn.cursor()
        cur.execute("SELECT metric_name FROM telemetry WHERE asset_id = %s;", (VAL_QUARANTINE_DEVICE,))
        q_rows = cur.fetchall()
        if len(q_rows) == 0:
            print(f"✅ 4. QUARANTINE TELEMETRY GATING: Verified 0 telemetry records ingested for quarantined device '{VAL_QUARANTINE_DEVICE}'.")
        else:
            print(f"❌ 4. QUARANTINE TELEMETRY GATING FAIL: Found {len(q_rows)} telemetry records in TimescaleDB for quarantined device '{VAL_QUARANTINE_DEVICE}'.")
            passed = False
        conn.close()
    except Exception as e:
        print(f"❌ 4. QUARANTINE TELEMETRY GATING ERROR: {e}")
        passed = False

    print("==========================================")
    if passed:
        print("🎉 END-TO-END VALIDATION PASSED SUCCESSFULLY!")
        return True
    else:
        print("💥 END-TO-END VALIDATION FAILED!")
        return False

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Supabase + TimescaleDB End-to-End Validation Script")
    parser.add_argument("--cleanup", action="store_true", help="Clean up test data and exit")
    parser.add_argument("--keep-data", action="store_true", help="Keep test data after running validation")
    args = parser.parse_args()

    if args.cleanup:
        cleanup_validation_data()
        sys.exit(0)

    success = False
    try:
        cleanup_validation_data()
        seed_supabase()
        run_simulation()
        success = verify_results()
    finally:
        if not args.keep_data:
            cleanup_validation_data()

    sys.exit(0 if success else 1)
