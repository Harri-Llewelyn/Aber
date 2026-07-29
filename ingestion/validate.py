import os
import sys
import time
import argparse
import psycopg2
import paho.mqtt.client as mqtt
import sparkplug_b_pb2
from datetime import datetime, timezone, timedelta

# The report is written with ✅/❌ markers. A Windows console defaults to cp1252, where printing
# those raises UnicodeEncodeError -- which surfaces as a crash inside the *reporting* code and
# looks like a validation failure rather than a console limitation. Force UTF-8 on the streams.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

# Configuration
TIMESCALEDB_HOST = os.getenv("DB_HOST", "localhost")
TIMESCALEDB_PORT = os.getenv("DB_PORT", "5433" if os.getenv("DB_HOST") is None else "5432")
TIMESCALEDB_NAME = os.getenv("DB_NAME", "postgres")
TIMESCALEDB_USER = os.getenv("DB_USER", "postgres")
TIMESCALEDB_PASS = os.getenv("DB_PASSWORD", "postgres")

MQTT_HOST = os.getenv("MQTT_HOST", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

# Identifiers for validation.
#
# Names are labels only. Identity on the wire is the `sparkplug_id` each row is issued, which
# is derived from its UUID primary key -- so the seeded ids are read back after insert rather
# than being knowable up front.
VAL_CELL_NAME = "VALIDATE Cell 1"
VAL_GW_NAME = "VALIDATE_Gateway_01"
VAL_KNOWN_DEVICE = "VALIDATE_Device_001"
VAL_LEGACY_DEVICE = "VALIDATE_Legacy_Device_001"
VAL_MISMATCH_DEVICE = "VALIDATE_Mismatch_Device_001"
VAL_QUARANTINE_DEVICE = "VALIDATE_Quarantine_Device_001"
VAL_MALFORMED_DEVICE = "VALIDATE_Malformed_Device_001"
VAL_RENAMED_DEVICE = "VALIDATE_Device_001_Renamed"

# A well-formed device id that is deliberately not registered: 'dev' + 21 hex = 24 characters.
UNKNOWN_DEVICE_ID = "dev" + "f" * 21
# The same id one character short -- the truncation case the format check exists to diagnose.
MALFORMED_DEVICE_ID = "dev" + "f" * 20

# Populated by seed_supabase(); the wire ids the daemon will resolve.
SEEDED = {}

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
        # Telemetry is keyed by sparkplug_id, which is per-run (it comes from the seeded row's
        # generated UUID), so the rows are found via the friendly name cached on `assets`.
        cur.execute(
            "DELETE FROM telemetry WHERE asset_id IN "
            "(SELECT asset_id FROM assets WHERE asset_name LIKE 'VALIDATE_%');"
        )
        cur.execute("DELETE FROM assets WHERE asset_name LIKE 'VALIDATE_%';")
        conn.close()
    except Exception as e:
        print(f"TimescaleDB cleanup warning: {e}")

    print("Cleanup complete.")

def make_sparkplug_payload(asset_id, metrics_dict, timestamp_ms, asset_name=None):
    payload = sparkplug_b_pb2.Payload()
    payload.timestamp = timestamp_ms

    m_asset = payload.metrics.add()
    m_asset.name = "Asset_ID"
    m_asset.string_value = asset_id
    m_asset.datatype = 12

    # The friendly-name hint. Only ever used to label a newly discovered device; the daemon
    # must never apply it to an existing row.
    if asset_name:
        m_name = payload.metrics.add()
        m_name.name = "Asset_Name"
        m_name.string_value = asset_name
        m_name.datatype = 12

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
    print("Seeding Supabase test metadata (cells, gateways, registered devices)...")
    if not supabase_client:
        print("Skipping Supabase seed: client unavailable")
        return

    # Seed cell
    c_res = supabase_client.table("cells").insert({"name": VAL_CELL_NAME}).execute()
    cell_id = c_res.data[0]["id"] if c_res.data else None

    # Seed gateway
    g_res = supabase_client.table("gateways").insert({"name": VAL_GW_NAME, "cell_id": cell_id, "status": "ONLINE"}).execute()
    gateway = g_res.data[0] if g_res.data else {}
    SEEDED["gateway_uuid"] = gateway.get("id")
    SEEDED["gateway_id"] = gateway.get("sparkplug_id")

    # Seed the registered devices. sparkplug_id is a generated column, so it comes back on the
    # insert -- these are the ids the simulated gateways will publish under.
    for label, key in (
        (VAL_KNOWN_DEVICE, "known"),
        (VAL_LEGACY_DEVICE, "legacy"),
        (VAL_MISMATCH_DEVICE, "mismatch"),
    ):
        res = supabase_client.table("devices").insert({
            "name": label,
            "gateway_id": SEEDED["gateway_uuid"],
            "status": "ONLINE",
            "is_quarantined": False
        }).execute()
        row = res.data[0] if res.data else {}
        SEEDED[key + "_uuid"] = row.get("id")
        SEEDED[key + "_id"] = row.get("sparkplug_id")

    missing = [k for k, v in SEEDED.items() if not v]
    if missing:
        print(f"⚠️  Seed incomplete, missing: {missing}")

    print("Supabase test metadata seeded successfully.")
    print(f"  Gateway  {VAL_GW_NAME}     -> {SEEDED.get('gateway_id')}")
    print(f"  Device   {VAL_KNOWN_DEVICE} -> {SEEDED.get('known_id')}")

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
    gw = SEEDED.get("gateway_id") or VAL_GW_NAME

    def publish(msg_type, device_id, metrics, asset_id=None, asset_name=None):
        """Publish under `device_id`. asset_id overrides the Asset_ID metric to force a mismatch."""
        payload = make_sparkplug_payload(asset_id or device_id, metrics, now_ms, asset_name)
        client.publish(f"spBv1.0/Group1/{msg_type}/{gw}/{device_id}", payload)
        time.sleep(2)

    # 1. DBIRTH for an unknown but well-formed device id -> quarantined, reason UNKNOWN_DEVICE
    print(f"\n--- DBIRTH from unregistered device id: {UNKNOWN_DEVICE_ID} ---")
    publish("DBIRTH", UNKNOWN_DEVICE_ID, {"firmware": "v1.0.0"}, asset_name=VAL_QUARANTINE_DEVICE)

    # 2. DDATA for that quarantined device -> gated, nothing reaches TimescaleDB
    print(f"\n--- DDATA from quarantined device: {UNKNOWN_DEVICE_ID} ---")
    publish("DDATA", UNKNOWN_DEVICE_ID, {"temperature": 99.9, "status": "QUARANTINED"})

    # 3. DDATA for the registered device -> ingested, keyed by its sparkplug_id
    print(f"\n--- DDATA from registered device: {VAL_KNOWN_DEVICE} ({SEEDED.get('known_id')}) ---")
    publish("DDATA", SEEDED["known_id"], {"temperature": 42.5, "status": "RUNNING", "safety_ok": True})

    # 4. DBIRTH under a truncated id -> quarantined with a message naming the length mismatch.
    #    This is the whole point of the fixed 24-character format: a misconfigured gateway is
    #    diagnosable rather than just another anonymous unknown device.
    print(f"\n--- DBIRTH from a malformed (23-character) device id: {MALFORMED_DEVICE_ID} ---")
    publish("DBIRTH", MALFORMED_DEVICE_ID, {"firmware": "v1.0.0"}, asset_name=VAL_MALFORMED_DEVICE)

    # 5. DDATA whose topic and Asset_ID metric disagree -> the topic wins and the device is
    #    quarantined, rather than the metric silently deciding which asset this is.
    print(f"\n--- DDATA with contradictory Asset_ID: {VAL_MISMATCH_DEVICE} ---")
    publish("DBIRTH", SEEDED["mismatch_id"], {"firmware": "v1.0.0"}, asset_id=UNKNOWN_DEVICE_ID)

    # 6. Legacy device still publishing its name -> resolved by name during the migration
    #    window, flagged identity_source = 'legacy_name'. The birth is what records how the
    #    device was resolved, so it has to be sent before the DDATA.
    print(f"\n--- DBIRTH/DDATA from a legacy name-addressed device: {VAL_LEGACY_DEVICE} ---")
    publish("DBIRTH", VAL_LEGACY_DEVICE, {"firmware": "v0.9.0"})
    publish("DDATA", VAL_LEGACY_DEVICE, {"temperature": 30.0, "status": "RUNNING"})

    # 7. The acceptance test for the whole change: rename the device, then publish again.
    #    Telemetry must continue landing on the same series.
    if supabase_client and SEEDED.get("known_uuid"):
        print(f"\n--- Renaming {VAL_KNOWN_DEVICE} -> {VAL_RENAMED_DEVICE}, then publishing again ---")
        supabase_client.table("devices").update({"name": VAL_RENAMED_DEVICE}).eq("id", SEEDED["known_uuid"]).execute()
        time.sleep(6)  # outlast the daemon's 5s device-resolution cache
        publish("DDATA", SEEDED["known_id"], {"temperature": 43.5, "status": "RUNNING_AFTER_RENAME"})

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
            res = supabase_client.table("devices").select("*").eq("reported_identity", UNKNOWN_DEVICE_ID).execute()
            devices = res.data if res else []
            dev = devices[0] if devices else None
            if dev and dev.get("is_quarantined") is True:
                print("✅ 1. SUPABASE QUARANTINE: Unregistered device DBIRTH auto-inserted with is_quarantined = True.")
                print(f"      -> reported_identity={dev.get('reported_identity')} reason={dev.get('quarantine_reason')}")
                if dev.get("gateway_id") != SEEDED.get("gateway_uuid"):
                    print("❌ 1b. QUARANTINE PROVENANCE FAIL: the arriving edge node was not recorded on the row.")
                    passed = False
                else:
                    print("✅ 1b. QUARANTINE PROVENANCE: arriving edge node recorded on the quarantined row.")
                if dev.get("name") != VAL_QUARANTINE_DEVICE:
                    print(f"❌ 1c. NAME HINT FAIL: expected the Asset_Name hint '{VAL_QUARANTINE_DEVICE}', got '{dev.get('name')}'.")
                    passed = False
                else:
                    print("✅ 1c. NAME HINT: the device's Asset_Name metric labelled the new row.")
            else:
                print(f"❌ 1. SUPABASE QUARANTINE FAIL: no quarantined device reported '{UNKNOWN_DEVICE_ID}'.")
                passed = False
        except Exception as e:
            print(f"❌ 1. SUPABASE QUARANTINE ERROR: {e}")
            passed = False

        # 1d. Malformed identity must be quarantined with a diagnosis, not dropped.
        try:
            res = supabase_client.table("devices").select("*").eq("reported_identity", MALFORMED_DEVICE_ID).execute()
            rows = res.data if res else []
            reason = rows[0].get("quarantine_reason", "") if rows else ""
            if rows and "MALFORMED_IDENTITY" in reason and "23 characters" in reason:
                print("✅ 1d. MALFORMED IDENTITY: truncated id quarantined with an actionable message.")
                print(f"      -> {reason}")
            elif rows:
                print(f"❌ 1d. MALFORMED IDENTITY FAIL: quarantined, but the reason is unhelpful: '{reason}'")
                passed = False
            else:
                print(f"❌ 1d. MALFORMED IDENTITY FAIL: '{MALFORMED_DEVICE_ID}' was dropped instead of quarantined.")
                passed = False
        except Exception as e:
            print(f"❌ 1d. MALFORMED IDENTITY ERROR: {e}")
            passed = False

        # 1e. Topic must beat the Asset_ID metric, and a disagreement must quarantine.
        try:
            res = supabase_client.table("devices").select("*").eq("id", SEEDED.get("mismatch_uuid")).execute()
            rows = res.data if res else []
            reason = rows[0].get("quarantine_reason", "") if rows else ""
            if rows and rows[0].get("is_quarantined") and "IDENTITY_MISMATCH" in reason:
                print("✅ 1e. IDENTITY MISMATCH: topic/Asset_ID disagreement quarantined the device.")
            else:
                print(f"❌ 1e. IDENTITY MISMATCH FAIL: expected a quarantined device, got reason '{reason}'.")
                passed = False
        except Exception as e:
            print(f"❌ 1e. IDENTITY MISMATCH ERROR: {e}")
            passed = False

        # 1f. Legacy name matching must still work during the migration window, and be flagged.
        try:
            res = supabase_client.table("devices").select("*").eq("id", SEEDED.get("legacy_uuid")).execute()
            rows = res.data if res else []
            if rows and rows[0].get("identity_source") == "legacy_name":
                print("✅ 1f. LEGACY FALLBACK: name-addressed device resolved and flagged 'legacy_name'.")
            else:
                src = rows[0].get("identity_source") if rows else None
                print(f"❌ 1f. LEGACY FALLBACK FAIL: expected identity_source 'legacy_name', got '{src}'.")
                passed = False
        except Exception as e:
            print(f"❌ 1f. LEGACY FALLBACK ERROR: {e}")
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
    known_key = SEEDED.get("known_id")
    try:
        conn = get_timescaledb_connection()
        cur = conn.cursor()
        cur.execute("SELECT metric_name, val_double, val_string, val_bool FROM telemetry WHERE asset_id = %s;", (known_key,))
        rows = cur.fetchall()
        if len(rows) > 0:
            print(f"✅ 3. TIMESCALEDB TELEMETRY: Ingested {len(rows)} metrics keyed by sparkplug_id '{known_key}'.")
            for r in rows:
                print(f"      -> Metric: {r[0]:<22} double={r[1]} string={r[2]} bool={r[3]}")
        else:
            print(f"❌ 3. TIMESCALEDB TELEMETRY FAIL: No telemetry records found for '{known_key}'.")
            passed = False

        # 3b. The acceptance test: telemetry published after the rename must land on the SAME
        # series. Under name-based identity this is precisely what used to break.
        cur.execute(
            "SELECT COUNT(*) FROM telemetry WHERE asset_id = %s AND val_string = 'RUNNING_AFTER_RENAME';",
            (known_key,)
        )
        after_rename = cur.fetchone()[0]
        cur.execute("SELECT asset_name FROM assets WHERE asset_id = %s;", (known_key,))
        cached = cur.fetchone()
        cached_name = cached[0] if cached else None

        if after_rename > 0:
            print(f"✅ 3b. RENAME SAFETY: telemetry published after renaming the device landed on the "
                  f"same series '{known_key}' — the series survived the rename.")
        else:
            print("❌ 3b. RENAME SAFETY FAIL: no telemetry recorded after the rename; the series was "
                  "detached from the device.")
            passed = False

        if cached_name == VAL_RENAMED_DEVICE:
            print(f"✅ 3c. LABEL PROPAGATION: assets.asset_name refreshed to '{cached_name}'.")
        else:
            print(f"❌ 3c. LABEL PROPAGATION FAIL: assets.asset_name is '{cached_name}', "
                  f"expected '{VAL_RENAMED_DEVICE}'.")
            passed = False

        conn.close()
    except Exception as e:
        print(f"❌ 3. TIMESCALEDB TELEMETRY ERROR: {e}")
        passed = False

    # 4. Verify telemetry gating for quarantined device
    try:
        conn = get_timescaledb_connection()
        cur = conn.cursor()
        cur.execute(
            "SELECT metric_name FROM telemetry WHERE asset_id IN (%s, %s);",
            (UNKNOWN_DEVICE_ID, MALFORMED_DEVICE_ID)
        )
        q_rows = cur.fetchall()
        if len(q_rows) == 0:
            print("✅ 4. QUARANTINE TELEMETRY GATING: 0 telemetry records ingested for quarantined/malformed devices.")
        else:
            print(f"❌ 4. QUARANTINE TELEMETRY GATING FAIL: Found {len(q_rows)} telemetry records for quarantined devices.")
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

    # Print the resolved endpoints before doing anything. This script runs from the
    # host, so it needs published ports (localhost:5433 / 1883 / 54321) -- sourcing the
    # compose .env instead points it at in-network service names ("timescaledb",
    # "mosquitto") and every connection dies with "Temporary failure in name
    # resolution". Showing the targets up front makes that obvious from the log alone.
    print("Validation targets:")
    print(f"  MQTT broker  : {MQTT_HOST}:{MQTT_PORT}")
    print(f"  TimescaleDB  : {TIMESCALEDB_HOST}:{TIMESCALEDB_PORT}/{TIMESCALEDB_NAME}")
    print(f"  Supabase API : {SUPABASE_URL}")
    print(f"  Service role key: {'set' if SUPABASE_SERVICE_ROLE_KEY else 'MISSING'}")
    print()

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
