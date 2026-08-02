import os
import sys
import time
import argparse
import psycopg2
import paho.mqtt.client as mqtt
import sparkplug_b_pb2
from datetime import datetime, timezone

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

# Supabase's own PostgreSQL, addressed directly rather than through PostgREST. Needed only by
# the audit-row cleanup, which migration 0003 deliberately put out of reach of `service_role`.
# Defaults match the published port in docker-compose.yml, so the script keeps working from the
# host with no extra configuration.
SUPABASE_DB_HOST = os.getenv("SUPABASE_DB_HOST", "localhost")
SUPABASE_DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
SUPABASE_DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
SUPABASE_DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
SUPABASE_DB_PASS = os.getenv("POSTGRES_PASSWORD", "postgres")

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
VAL_SCHEMA_NAME = "VALIDATE_Schema_Robot_Standard"
# A second schema attached to the same device through device_submodels (migration 0034). It exists
# to prove the modelled set is the UNION across every attached submodel: VAL_KPI_METRIC is declared
# at birth and modelled ONLY here, so a reader that looked at one schema would wrongly flag it.
VAL_KPI_SCHEMA_NAME = "VALIDATE_Schema_OEE"

# The schema attached to the registered device, and a metric deliberately left out of it. The
# device declares the extra metric at birth, so it must surface as unmodelled -- and stop being
# unmodelled once the schema is widened, without the device rebirthing.
VAL_SCHEMA_METRICS = ["Systems/TEMPERATURE", "Controller/EXECUTION", "Controller/EMERGENCY_STOP"]
VAL_UNMODELLED_METRIC = "Environmental/HUMIDITY_RELATIVE"
VAL_KPI_METRIC = "OEE/AVAILABILITY"
VAL_KPI_SCHEMA_METRICS = [VAL_KPI_METRIC]

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

def modelled_metrics(schema_definition):
    """
    Python mirror of frontend/src/utils/deviceTags.js modelledMetrics(): the union of a schema's
    `properties` keys and its `required` list, or None when it declares neither and so cannot be
    evaluated. Kept in step with the JS deliberately -- both answer the same question.
    """
    if not isinstance(schema_definition, dict):
        return None
    properties = schema_definition.get("properties")
    required = schema_definition.get("required")
    names = set(properties.keys()) if isinstance(properties, dict) else set()
    if isinstance(required, list):
        names |= set(required)
    return names or None


def modelled_metrics_across(schema_definitions):
    """
    Python mirror of modelledMetricsAcross() in frontend/src/utils/deviceTags.js: the union of the
    metrics every attached submodel models, or None when none of them can be evaluated.

    A device may have several schemas attached through device_submodels (migration 0034), one AAS
    Submodel each. A metric modelled by any one of them is modelled -- judging against a single
    schema would flag a device for publishing what another of its own submodels accounts for.
    """
    union = set()
    evaluable = False
    for definition in schema_definitions or []:
        modelled = modelled_metrics(definition)
        if modelled is None:
            continue
        evaluable = True
        union |= modelled
    return union if evaluable else None


def unmodelled_metrics(declared, schema_definitions):
    """
    Metrics declared at the last birth that no attached submodel accounts for.

    Accepts a single definition or a list of them, so existing single-schema callers keep working.
    """
    if not declared:
        return []
    if isinstance(schema_definitions, dict) or schema_definitions is None:
        schema_definitions = [schema_definitions]
    modelled = modelled_metrics_across(schema_definitions)
    if modelled is None:
        return []
    return sorted(set(declared) - modelled)


def device_schema_definitions(device_uuid):
    """
    Every schema definition attached to a device, resolved through the `device_schemas` view.

    The view is the union of device_submodels and the legacy 1:1 devices.schema_id, so this is the
    same resolution the exporter and the frontend use rather than a third one that could disagree.
    """
    if not supabase_client or not device_uuid:
        return []
    links = supabase_client.table("device_schemas").select("schema_id").eq(
        "device_id", device_uuid
    ).execute()
    ids = [row["schema_id"] for row in (links.data or []) if row.get("schema_id")]
    if not ids:
        return []
    rows = supabase_client.table("schemas").select("id,schema_definition").in_("id", ids).execute()
    return [r["schema_definition"] for r in (rows.data or [])]


def get_timescaledb_connection():
    return psycopg2.connect(
        host=TIMESCALEDB_HOST,
        port=TIMESCALEDB_PORT,
        database=TIMESCALEDB_NAME,
        user=TIMESCALEDB_USER,
        password=TIMESCALEDB_PASS
    )


def get_supabase_admin_connection():
    """
    A direct owner connection to the Supabase database, used only to clear this run's audit rows.

    WHY NOT THROUGH POSTGREST, WHICH IS HOW EVERYTHING ELSE HERE IS DONE. Migration 0003 makes
    public.digital_thread genuinely append-only: a BEFORE UPDATE OR DELETE trigger rejects the
    operation for every application role, `service_role` included. That is the point of the
    change -- the service key ships in .env and is held by ingestion and all four edge functions,
    so an audit trail that key could rewrite was not much of an audit trail.

    Clearing fixture rows is therefore, deliberately, an act that needs owner authority. The
    trigger exempts `postgres` because a role that can issue DDL can drop the trigger anyway, so
    pretending otherwise would be theatre.
    """
    return psycopg2.connect(
        host=SUPABASE_DB_HOST,
        port=SUPABASE_DB_PORT,
        database=SUPABASE_DB_NAME,
        user=SUPABASE_DB_USER,
        password=SUPABASE_DB_PASS,
    )

def cleanup_validation_data():
    print("Cleaning up validation data...")
    if supabase_client:
        try:
            # Audit rows are keyed by entity_id, and log_digital_thread_event() only ever writes
            # 'devices' / 'gateways' / 'cells' into entity_type -- so the ids have to be collected
            # while the rows carrying the VALIDATE_ names still exist. Deleting the entities first
            # loses the only link back to their audit trail.
            #
            # This previously filtered `entity_type LIKE '%VALIDATE%'`, which matches none of those
            # three values and so silently deleted nothing on every run since it was written. The
            # audit rows from every validation run were left in an append-only table for good.
            stale_ids = []
            for table, column, value in (
                ("devices", "name", "VALIDATE_%"),
                ("gateways", "name", "VALIDATE_%"),
                ("cells", "name", None),
            ):
                query = supabase_client.table(table).select("id")
                query = query.eq(column, VAL_CELL_NAME) if value is None else query.like(column, value)
                stale_ids += [row["id"] for row in (query.execute().data or []) if row.get("id")]

            # Deleting the cell cascades to its gateways (gateways.cell_id ON DELETE CASCADE), so
            # ordering matters here even though devices.gateway_id is only SET NULL.
            supabase_client.table("devices").delete().like("name", "VALIDATE_%").execute()
            supabase_client.table("gateways").delete().like("name", "VALIDATE_%").execute()
            supabase_client.table("cells").delete().eq("name", VAL_CELL_NAME).execute()
            # schema_name is UNIQUE, so a schema left behind by an aborted run would fail the
            # next seed. devices.schema_id is ON DELETE SET NULL, so ordering does not matter.
            supabase_client.table("schemas").delete().like("schema_name", "VALIDATE_%").execute()

            # Guarded: an empty `in_` list is not a no-op filter, and an unfiltered delete against
            # digital_thread would wipe the whole audit history.
            #
            # Routed through an owner connection rather than PostgREST because 0003's append-only
            # trigger refuses DELETE for service_role -- see get_supabase_admin_connection().
            if stale_ids:
                audit_conn = get_supabase_admin_connection()
                try:
                    audit_conn.autocommit = True
                    with audit_conn.cursor() as cur:
                        cur.execute(
                            "DELETE FROM public.digital_thread WHERE entity_id = ANY(%s::uuid[])",
                            (stale_ids,),
                        )
                finally:
                    audit_conn.close()
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
    # Kept on SEEDED so check 2 can scope itself to this run's entities: digital_thread is keyed
    # by entity_id, and the cell's id is otherwise not recoverable once the row is deleted.
    SEEDED["cell_uuid"] = cell_id

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

    # Seed a schema and attach it to the registered device, so birth-declared metrics have
    # something to be judged against. Without an assigned schema a device is deliberately never
    # flagged as unmodelled -- "publishes beyond its model" and "has no model" are different
    # findings -- so this is a prerequisite of checks 6c/6d, not decoration.
    #
    # SEEDED AS A DRAFT, deliberately. Migration 0037 freezes every column but `status` on an
    # `active` or `archived` schema, and that guard applies to `service_role` as well as to
    # `authenticated` -- deliberately, since a trusted key is still not a reason to redefine a
    # contract devices are provisioned against. Check 6d widens this schema in place to prove the
    # unmodelled verdict is derived rather than stored, so the fixture has to be in the one state
    # that is editable. A fixture that had to be forked to be edited would be testing versioning,
    # not derivation.
    s_res = supabase_client.table("schemas").insert({
        "schema_name": VAL_SCHEMA_NAME,
        "description": "End-to-end validation schema",
        "status": "draft",
        "schema_definition": {
            "type": "object",
            # SAMPLE data items are numeric; EVENT data items carry a controlled string.
            "properties": {
                name: {"type": "number" if name.endswith("TEMPERATURE") else "string"}
                for name in VAL_SCHEMA_METRICS
            },
            "required": VAL_SCHEMA_METRICS,
        },
    }).execute()
    SEEDED["schema_uuid"] = s_res.data[0]["id"] if s_res.data else None

    # The second submodel. Only this schema models VAL_KPI_METRIC, so checks 6c/6e fail unless the
    # verdict is computed across both attachments.
    k_res = supabase_client.table("schemas").insert({
        "schema_name": VAL_KPI_SCHEMA_NAME,
        "description": "End-to-end validation KPI submodel",
        # Same reason as the schema above: a draft is the editable state (migration 0037).
        "status": "draft",
        "schema_definition": {
            "type": "object",
            "properties": {name: {"type": "number"} for name in VAL_KPI_SCHEMA_METRICS},
            "required": VAL_KPI_SCHEMA_METRICS,
        },
    }).execute()
    SEEDED["kpi_schema_uuid"] = k_res.data[0]["id"] if k_res.data else None

    if SEEDED.get("schema_uuid") and SEEDED.get("known_uuid"):
        # devices.schema_id is still written: it is the fallback arm migration 0034 deliberately
        # retains, and leaving it unset would mean the join table were the only thing under test.
        supabase_client.table("devices").update(
            {"schema_id": SEEDED["schema_uuid"]}
        ).eq("id", SEEDED["known_uuid"]).execute()

        # Both schemas attached as submodels. The first duplicates devices.schema_id on purpose --
        # the view must not return it twice.
        for schema_key in ("schema_uuid", "kpi_schema_uuid"):
            if SEEDED.get(schema_key):
                supabase_client.table("device_submodels").insert({
                    "device_id": SEEDED["known_uuid"],
                    "schema_id": SEEDED[schema_key],
                }).execute()

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
    publish("DDATA", UNKNOWN_DEVICE_ID, {"Systems/TEMPERATURE": 99.9, "Controller/EXECUTION": "STOPPED"})

    # 3. DDATA for the registered device -> ingested, keyed by its sparkplug_id
    print(f"\n--- DDATA from registered device: {VAL_KNOWN_DEVICE} ({SEEDED.get('known_id')}) ---")
    publish("DDATA", SEEDED["known_id"], {"Systems/TEMPERATURE": 42.5, "Controller/EXECUTION": "ACTIVE", "Controller/EMERGENCY_STOP": "ARMED"})

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
    publish("DDATA", VAL_LEGACY_DEVICE, {"Systems/TEMPERATURE": 30.0, "Controller/EXECUTION": "ACTIVE"})

    # 7. DBIRTH for the registered device declaring one metric its schema does not model.
    #    Published twice, identically: the daemon must record the declared set the first time
    #    and then write nothing at all the second, because log_digital_thread_event() fires on
    #    every UPDATE to `devices` and an unchanged rewrite per rebirth would append an audit
    #    row each time to a deliberately append-only table.
    print(f"\n--- DBIRTH from registered device declaring an unmodelled metric: {VAL_UNMODELLED_METRIC} ---")
    birth_metrics = {"Systems/TEMPERATURE": 42.5, "Controller/EXECUTION": "ACTIVE",
                     "Controller/EMERGENCY_STOP": "ARMED", VAL_UNMODELLED_METRIC: 55.2,
                     # Modelled only by the second attached submodel -- see check 6e.
                     VAL_KPI_METRIC: 0.92}
    publish("DBIRTH", SEEDED["known_id"], birth_metrics)

    if supabase_client and SEEDED.get("known_uuid"):
        res = supabase_client.table("devices").select("last_birth_metrics_at").eq(
            "id", SEEDED["known_uuid"]
        ).execute()
        SEEDED["birth_metrics_at"] = res.data[0]["last_birth_metrics_at"] if res.data else None

    print("\n--- Identical DBIRTH again: the declared set is unchanged, so nothing must be written ---")
    time.sleep(6)  # outlast the daemon's 5s device-resolution cache
    publish("DBIRTH", SEEDED["known_id"], birth_metrics)

    # 8. The acceptance test for the whole change: rename the device, then publish again.
    #    Telemetry must continue landing on the same series.
    if supabase_client and SEEDED.get("known_uuid"):
        print(f"\n--- Renaming {VAL_KNOWN_DEVICE} -> {VAL_RENAMED_DEVICE}, then publishing again ---")
        supabase_client.table("devices").update({"name": VAL_RENAMED_DEVICE}).eq("id", SEEDED["known_uuid"]).execute()
        time.sleep(6)  # outlast the daemon's 5s device-resolution cache
        # The sentinel goes on a local test metric rather than on Controller/EXECUTION, whose
        # values MTConnect constrains to READY/ACTIVE/INTERRUPTED/... Putting an arbitrary marker
        # there would make the validator publish exactly the kind of standard-name/non-standard-
        # value payload the simulator was just moved off.
        publish("DDATA", SEEDED["known_id"],
                {"Systems/TEMPERATURE": 43.5, "VALIDATE/RENAME_SENTINEL": "RUNNING_AFTER_RENAME"})

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

        # 5. asset_config must be populated from the birth certificate. This is the regression
        # guard for a rename that left three stale `asset_id` references in
        # store_birth_parameters(), making it raise NameError on every DBIRTH -- swallowed by
        # process_dbirth's except, so the Config view was simply always empty and CI never knew.
        try:
            res = supabase_client.table("asset_config").select("metric_name").eq(
                "asset_id", SEEDED.get("known_id")
            ).execute()
            names = sorted(r["metric_name"] for r in (res.data or []))
            if names:
                print(f"✅ 5. DBIRTH PARAMETERS: {len(names)} birth parameters stored to asset_config.")
                print(f"      -> {', '.join(names)}")
            else:
                print("❌ 5. DBIRTH PARAMETERS FAIL: no asset_config rows recorded for "
                      f"'{SEEDED.get('known_id')}'; store_birth_parameters() is not writing.")
                passed = False
        except Exception as e:
            print(f"❌ 5. DBIRTH PARAMETERS ERROR: {e}")
            passed = False

        # 6. The birth-declared metric names must be recorded on the device row.
        try:
            res = supabase_client.table("devices").select(
                "last_birth_metrics,last_birth_metrics_at,schema_id"
            ).eq("id", SEEDED.get("known_uuid")).execute()
            row = res.data[0] if res.data else {}
            declared = row.get("last_birth_metrics")
            expected = sorted(VAL_SCHEMA_METRICS + [VAL_UNMODELLED_METRIC, VAL_KPI_METRIC])

            if declared and sorted(declared) == expected:
                print("✅ 6. BIRTH METRIC OBSERVATION: declared metric set recorded on the device row.")
                print(f"      -> {', '.join(sorted(declared))}")
            else:
                print(f"❌ 6. BIRTH METRIC OBSERVATION FAIL: expected {expected}, got {declared}.")
                passed = False

            # 6a. Identity metrics are not something a schema should model, so they must not
            # appear in the declared set even though every payload carries Asset_ID.
            if declared and not ({"Asset_ID", "Asset_Name"} & set(declared)):
                print("✅ 6a. IDENTITY EXCLUSION: Asset_ID/Asset_Name absent from the declared set.")
            elif declared:
                print("❌ 6a. IDENTITY EXCLUSION FAIL: identity metrics leaked into last_birth_metrics.")
                passed = False

            # 6b. The change-only write: an identical rebirth must not touch the row, or every
            # rebirth would append a digital_thread entry saying nothing changed.
            before = SEEDED.get("birth_metrics_at")
            after = row.get("last_birth_metrics_at")
            if before and after == before:
                print("✅ 6b. CHANGE-ONLY WRITE: identical rebirth left the row untouched.")
            elif before:
                print(f"❌ 6b. CHANGE-ONLY WRITE FAIL: last_birth_metrics_at moved {before} -> {after}; "
                      "an unchanged rebirth is rewriting the row and appending audit noise.")
                passed = False
            else:
                print("⚠️  6b. CHANGE-ONLY WRITE: skipped, no baseline timestamp captured.")

            # 6c. The verdict is derived, never stored: no attached submodel models
            # VAL_UNMODELLED_METRIC, so exactly that metric must come out as unmodelled -- while
            # VAL_KPI_METRIC, modelled only by the second submodel, must NOT.
            definitions = device_schema_definitions(SEEDED.get("known_uuid"))
            s_res = supabase_client.table("schemas").select("schema_definition").eq(
                "id", SEEDED.get("schema_uuid")
            ).execute()
            definition = s_res.data[0]["schema_definition"] if s_res.data else None
            extra = unmodelled_metrics(declared, definitions)
            if extra == [VAL_UNMODELLED_METRIC]:
                print(f"✅ 6c. UNMODELLED DETECTION: '{VAL_UNMODELLED_METRIC}' identified as outside the schema.")
            else:
                print(f"❌ 6c. UNMODELLED DETECTION FAIL: expected ['{VAL_UNMODELLED_METRIC}'], got {extra}.")
                passed = False

            # 6d. The acceptance test for deriving rather than storing the verdict: widening the
            # schema must clear the finding immediately, with no rebirth from the device. Had
            # ingestion written a flag instead, this would stay wrong until the device next
            # birthed -- which for a stable device can be weeks.
            widened = dict(definition or {})
            widened["properties"] = {**(widened.get("properties") or {}),
                                     VAL_UNMODELLED_METRIC: {"type": "number"}}
            supabase_client.table("schemas").update({"schema_definition": widened}).eq(
                "id", SEEDED.get("schema_uuid")
            ).execute()

            re_res = supabase_client.table("schemas").select("schema_definition").eq(
                "id", SEEDED.get("schema_uuid")
            ).execute()
            re_definition = re_res.data[0]["schema_definition"] if re_res.data else None
            cleared = unmodelled_metrics(
                declared, device_schema_definitions(SEEDED.get("known_uuid")))

            post_res = supabase_client.table("devices").select("last_birth_metrics_at").eq(
                "id", SEEDED.get("known_uuid")
            ).execute()
            untouched = (post_res.data[0]["last_birth_metrics_at"] if post_res.data else None) == after

            if cleared == [] and untouched:
                print("✅ 6d. SCHEMA EDIT CLEARS IT: widening the schema cleared the finding with no "
                      "rebirth, and without writing to the device row.")
            elif cleared != []:
                print(f"❌ 6d. SCHEMA EDIT FAIL: still reporting {cleared} after the schema was widened.")
                passed = False
            else:
                print("❌ 6d. SCHEMA EDIT FAIL: the device row was written during a schema-only edit.")
                passed = False
        except Exception as e:
            print(f"❌ 6. BIRTH METRIC OBSERVATION ERROR: {e}")
            passed = False

        # 6e. Phase 5: the modelled set is the union across every attached submodel. Asserted by
        # showing the same metric flips verdict depending on whether the second submodel is counted
        # -- otherwise this check would pass even if device_submodels were ignored entirely.
        try:
            definitions = device_schema_definitions(SEEDED.get("known_uuid"))
            primary_only = unmodelled_metrics(declared, definition)
            across_all = unmodelled_metrics(declared, definitions)

            if len(definitions) < 2:
                print(f"❌ 6e. MULTI-SUBMODEL FAIL: expected 2 attached schemas, resolved {len(definitions)}.")
                passed = False
            elif VAL_KPI_METRIC in primary_only and VAL_KPI_METRIC not in across_all:
                print(f"✅ 6e. MULTI-SUBMODEL: '{VAL_KPI_METRIC}' is modelled only by the second "
                      f"attached submodel, and the union across {len(definitions)} schemas accounts for it.")
            else:
                print(f"❌ 6e. MULTI-SUBMODEL FAIL: primary-only={primary_only}, union={across_all}; "
                      f"'{VAL_KPI_METRIC}' should be unmodelled against the primary schema alone "
                      "and modelled across both.")
                passed = False
        except Exception as e:
            print(f"❌ 6e. MULTI-SUBMODEL ERROR: {e}")
            passed = False

        # 2. Verify Digital Thread triggers
        #
        # Scoped to the entities this run created. Selecting the whole table and asserting it is
        # non-empty -- which is what this did -- passes on audit rows from any source: a migration,
        # the demo device booting, an edit made in the UI. It could never fail once the table was
        # non-empty for any reason, so it did not actually exercise the trigger.
        #
        # Both actions are required because log_digital_thread_event() is one function serving
        # INSERT, UPDATE and DELETE, and the run performs the first two: the seed inserts a cell,
        # a gateway and three devices, and the rename updates one of them.
        try:
            run_entity_ids = [
                SEEDED[key] for key in ("cell_uuid", "gateway_uuid", "known_uuid", "legacy_uuid", "mismatch_uuid")
                if SEEDED.get(key)
            ]
            if not run_entity_ids:
                print("❌ 2. DIGITAL THREAD TRIGGERS FAIL: no seeded entity ids to check against.")
                passed = False
            else:
                res_thread = supabase_client.table("digital_thread").select(
                    "entity_type,entity_id,action"
                ).in_("entity_id", run_entity_ids).execute()
                logs = res_thread.data if res_thread else []
                actions = {row.get("action") for row in logs}
                if "INSERT" in actions and "UPDATE" in actions:
                    print(f"✅ 2. DIGITAL THREAD TRIGGERS: {len(logs)} audit entries written for this run's "
                          f"{len(run_entity_ids)} entities, covering {', '.join(sorted(actions))}.")
                elif logs:
                    print(f"❌ 2. DIGITAL THREAD TRIGGERS FAIL: {len(logs)} entries for this run's entities but "
                          f"actions were {sorted(actions)}; expected both INSERT and UPDATE.")
                    passed = False
                else:
                    print("❌ 2. DIGITAL THREAD TRIGGERS FAIL: no audit entries for any entity this run created.")
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
