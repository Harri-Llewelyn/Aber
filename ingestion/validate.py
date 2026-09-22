import os
import ssl
import sys
import time
import json
import argparse
import urllib.error
import urllib.request
import psycopg2
import paho.mqtt.client as mqtt
import sparkplug_b_pb2
from datetime import datetime, timezone

# The report is written with ✅/❌ markers, which raise UnicodeEncodeError on a cp1252 Windows
# console. Force UTF-8 on the streams.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

# Configuration. Defaults target a host run through `npm run dev:test`'s port-forwards; the
# in-cluster Job overrides them with Service names. See ../ingestion/README.md, "End-to-end
# validation". The port defaults are conditional on their host being set: 5433/54322 are the
# forwarded ports, and naming a host means the service is addressed directly on 5432.
TIMESCALEDB_HOST = os.getenv("DB_HOST", "localhost")
TIMESCALEDB_PORT = os.getenv("DB_PORT", "5433" if os.getenv("DB_HOST") is None else "5432")
TIMESCALEDB_NAME = os.getenv("DB_NAME", "postgres")
TIMESCALEDB_USER = os.getenv("DB_USER", "postgres")
TIMESCALEDB_PASS = os.getenv("DB_PASSWORD", "postgres")

# Supabase's own PostgreSQL, addressed directly rather than through PostgREST. Needed only by the
# audit-row cleanup, which the append-only trigger puts out of reach of `service_role`. The port
# default mirrors TIMESCALEDB_PORT's conditional for the same reason.
SUPABASE_DB_HOST = os.getenv("SUPABASE_DB_HOST", "localhost")
SUPABASE_DB_PORT = os.getenv(
    "SUPABASE_DB_PORT", "54322" if os.getenv("SUPABASE_DB_HOST") is None else "5432"
)
SUPABASE_DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
SUPABASE_DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
SUPABASE_DB_PASS = os.getenv("POSTGRES_PASSWORD", "postgres")

MQTT_HOST = os.getenv("MQTT_HOST", "localhost")
MQTT_PORT = int(os.getenv("MQTT_PORT", 1883))
# The same transport contract as ingestion.py, i3x_service.py and node-red-init.mjs: the chart's
# `mosquitto.tls.internalClients` sets all three names at once, and a CA file that is named but
# absent refuses to start rather than verify against the system store.
MQTT_TLS_ENABLED = os.getenv("MQTT_TLS_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")
MQTT_TLS_CA_FILE = os.getenv("MQTT_TLS_CA_FILE", "").strip()

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
# The secret key IS the service-role credential at the gateway: presented as apikey and bearer,
# it reaches PostgREST as `service_role`. The publishable key is the anonymous caller's. The
# service-role JWT is read only by check 14, which proves the gateway refuses it as an apikey.
SUPABASE_SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY", "")
SUPABASE_PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

# Node-RED as reached from the host, the published port. Check 7 asserts this address refuses
# unauthenticated callers. No conditional default: there is no separate host variable to key off.
NODERED_BASE_URL = os.getenv("NODERED_BASE_URL", "http://localhost:1880")

# Identifiers for validation. Names are labels only; identity on the wire is the `sparkplug_id` each
# row is issued, derived from its UUID, so the seeded ids are read back after insert.
VAL_CELL_NAME = "VALIDATE Cell 1"
VAL_GW_NAME = "VALIDATE_Gateway_01"
VAL_KNOWN_DEVICE = "VALIDATE_Device_001"
VAL_LEGACY_DEVICE = "VALIDATE_Legacy_Device_001"
VAL_MISMATCH_DEVICE = "VALIDATE_Mismatch_Device_001"
VAL_QUARANTINE_DEVICE = "VALIDATE_Quarantine_Device_001"
VAL_MALFORMED_DEVICE = "VALIDATE_Malformed_Device_001"
VAL_RENAMED_DEVICE = "VALIDATE_Device_001_Renamed"
# A device of its own for the alias suite: an extra DBIRTH on VAL_KNOWN_DEVICE would rewrite
# last_birth_metrics and break checks 6 and 6b.
VAL_ALIAS_DEVICE = "VALIDATE_Alias_Device_001"
VAL_SCHEMA_NAME = "VALIDATE_Schema_Robot_Standard"
# A second schema attached to the same device through device_submodels, to prove the modelled set is
# the union across every attached submodel: VAL_KPI_METRIC is declared at birth and modelled only
# here.
VAL_KPI_SCHEMA_NAME = "VALIDATE_Schema_OEE"

# The schema attached to the registered device, and a metric deliberately left out of it, so it
# surfaces as unmodelled and stops being unmodelled once the schema is widened, without a rebirth.
VAL_SCHEMA_METRICS = ["Systems/TEMPERATURE", "Controller/EXECUTION", "Controller/EMERGENCY_STOP"]
VAL_UNMODELLED_METRIC = "Environmental/HUMIDITY_RELATIVE"
VAL_KPI_METRIC = "OEE/AVAILABILITY"
VAL_KPI_SCHEMA_METRICS = [VAL_KPI_METRIC]

# A well-formed device id that is deliberately not registered: 'dev' + 21 hex = 24 characters.
UNKNOWN_DEVICE_ID = "dev" + "f" * 21
# The same id one character short -- the truncation case the format check exists to diagnose.
MALFORMED_DEVICE_ID = "dev" + "f" * 20

# The Sparkplug Group ID every message in this run is published under; the alias table and the
# rebirth topic are both scoped by it. Must match gateways.sparkplug_group, which defaults to the
# site's group (0131), or every check would exercise the deprecated fallback arm.
VAL_GROUP = os.getenv("SPARKPLUG_GROUP", "ACS-Cymru")

# The validator's gateway UUID is pinned so it can hold an ordinary per-gateway MQTT credential:
# The broker's roles confine a client to `spBv1.0/+/+/<sparkplug_id>/#`, so the username must equal the gateway
# row's generated `sparkplug_id`, which is a pure function of this constant
# (11000000-0000-4000-8000-000000000001 -> gwy110000000000400080000). Only the gateway is pinned;
# devices sit in the fifth topic segment, which the ACL's trailing `#` covers. The first 21 hex
# characters are what matter, so do not derive a second fixture id by incrementing the last group.
VAL_GW_UUID = "11000000-0000-4000-8000-000000000001"
VAL_GW_SPARKPLUG_ID = "gwy110000000000400080000"

# Sparkplug metric aliases for check 8. 100 is declared by the gateway's NBIRTH and used by a
# device's DDATA: Sparkplug scopes alias uniqueness to the edge node including its devices.
ALIAS_NODE_SCOPED = 100
ALIAS_TEMPERATURE = 101
ALIAS_EXECUTION = 102
ALIAS_NODE_METRIC = "VALIDATE/NODE_SCOPED_ALIAS"
# Never declared in any birth -- the cold-start case that must trigger a rebirth request.
ALIAS_UNDECLARED = 9999
ALIAS_UNDECLARED_SECOND = 9998

# The daemon's watchdog window, read so check 10 can decide whether it is short enough to wait
# for. This must match what the INGESTION CONTAINER was given, not merely what this shell has.
WATCHDOG_TIMEOUT = int(os.getenv("DEVICE_OFFLINE_TIMEOUT_SECONDS", "300"))
WATCHDOG_INTERVAL = int(os.getenv("DEVICE_WATCHDOG_INTERVAL_SECONDS", "30"))
# Above this the check reports SKIP rather than stalling a CI run for minutes.
WATCHDOG_MAX_WAIT_SECONDS = 90

# NCMD rebirth requests seen on the wire, appended by the validation subscriber.
CAPTURED_NCMD = []

# The Sparkplug primary host the daemon announces itself as. Read from THIS script's environment
# for the reason the watchdog values above are: the assertion is only meaningful against the value
# the ingestion container was actually given, and the chart passes both from one helper.
PRIMARY_HOST_ID = os.getenv("PRIMARY_HOST_ID", "").strip()

# Retained primary-host STATE messages seen on the wire, appended by the validation subscriber.
# This validator connects as an ordinary gateway account, so what it can read here is exactly what
# a physical third-party gateway can read.
CAPTURED_STATE = []

# Populated by seed_supabase(); the wire ids the daemon will resolve.
SEEDED = {}

supabase_client = None
try:
    from supabase import create_client
    supabase_client = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)
except Exception as e:
    print(f"Warning: Supabase client init failed: {e}")

def modelled_metrics(schema_definition):
    """Python mirror of frontend/src/utils/deviceTags.js modelledMetrics(): the union of a schema's
    `properties` keys and its `required` list, or None when it declares neither.
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
    """Python mirror of modelledMetricsAcross() in frontend/src/utils/deviceTags.js: the union of the
    metrics every attached submodel models, or None when none can be evaluated. A metric modelled by
    any one of a device's submodels is modelled.
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
    """Metrics declared at the last birth that no attached submodel accounts for. Accepts a single
    definition or a list of them.
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
    """Every schema definition attached to a device, resolved through the `device_schemas` view, the
    same resolution the exporter and the frontend use.
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


def probe_nodered_editor_login():
    """Drive the browser sign-in handshake against Node-RED and use the session it mints. Returns (ok,
    detail); see check 7b. The demo password is the seeded one from supabase/seed.sql. Not parse_qs
    on the exchange code: Node-RED redirects with `?code=` unencoded, the code is base64, and
    parse_qs maps a literal '+' to a space. unquote(), never unquote_plus().
    """
    import http.cookiejar
    import urllib.parse as urlparse

    client_secret = os.getenv("NODERED_OAUTH_CLIENT_SECRET", "")
    if not client_secret:
        return False, ("NODERED_OAUTH_CLIENT_SECRET is not set, so the sign-in cannot be "
                       "exercised. Node-RED refuses to boot without it, so this is a "
                       "configuration gap in this shell, not a passing state.")

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args):
            return None

    plain = urllib.request.build_opener()
    no_redirect = urllib.request.build_opener(_NoRedirect)
    jar = http.cookiejar.CookieJar()
    # The state and PKCE verifier live in Node-RED's express session, so the callback has to
    # arrive carrying the cookie the /auth/strategy request set -- exactly as a browser does.
    browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), _NoRedirect)

    def fetch(url, data=None, headers=None, opener=None):
        req = urllib.request.Request(url, data=data, headers=headers or {})
        try:
            return (opener or plain).open(req, timeout=15)
        except urllib.error.HTTPError as err:
            return err

    try:
        anon = SUPABASE_PUBLISHABLE_KEY
        token = json.loads(fetch(
            f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
            json.dumps({"email": "admin@aber.local", "password": "aber123"}).encode(),
            {"apikey": anon, "Content-Type": "application/json"},
        ).read())["access_token"]

        res = fetch(f"{NODERED_BASE_URL}/auth/strategy", opener=browser)
        authorize_url = res.headers.get("Location")
        if not authorize_url:
            return False, f"/auth/strategy did not redirect to the IdP (HTTP {res.status})."

        res = fetch(authorize_url, opener=no_redirect)
        location = res.headers.get("Location") or ""
        if "authorization_id=" not in location:
            return False, (f"GoTrue refused the authorize request (HTTP {res.status}). Check the "
                           "client registration and that NODERED_PUBLIC_URL matches redirect_uris.")
        authorization_id = location.split("authorization_id=")[1]

        # The GET is what binds the user to the authorization; /oauth/authorize leaves user_id
        # NULL. A remembered consent makes it answer with the finished redirect instead.
        details = json.loads(fetch(
            f"{SUPABASE_URL}/auth/v1/oauth/authorizations/{authorization_id}",
            headers={"apikey": anon, "Authorization": f"Bearer {token}"},
        ).read())
        callback = details.get("redirect_url")
        if not callback:
            callback = json.loads(fetch(
                f"{SUPABASE_URL}/auth/v1/oauth/authorizations/{authorization_id}/consent",
                json.dumps({"action": "approve"}).encode(),
                {"apikey": anon, "Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            ).read())["redirect_url"]

        res = fetch(callback, opener=browser)
        location = res.headers.get("Location") or ""
        if "session_message" in location:
            reason = urlparse.unquote(location.split("session_message=")[1])
            return False, f"Node-RED refused the sign-in: {reason}"
        if "?code=" not in location:
            return False, f"callback did not return an exchange code (HTTP {res.status})."

        code = urlparse.unquote(location.split("?code=", 1)[1])
        res = fetch(
            f"{NODERED_BASE_URL}/auth/token",
            json.dumps({"client": "node-red-editor", "code": code}).encode(),
            {"Content-Type": "application/json"}, opener=browser,
        )
        body = res.read().decode()
        editor_token = json.loads(body).get("accessToken") if res.status == 200 else None
        if not editor_token:
            return False, f"code exchange failed (HTTP {res.status}): {body[:120]}"

        # THE ASSERTIONS THAT MATTER. Everything above succeeded even with the defect that
        # shipped; this is the first call routed through adminAuth.users.
        settings_res = fetch(f"{NODERED_BASE_URL}/settings",
                             headers={"Authorization": f"Bearer {editor_token}"})
        if settings_res.status != 200:
            return False, (f"signed in, but the editor session is unusable: GET /settings -> "
                           f"{settings_res.status}. adminAuth.users is the usual cause -- "
                           "bearerStrategy resolves the user by username on every request.")

        # And that it carries the permissions, not merely a username: the editor draws a padlock on
        # Deploy when `permissions` is missing, while the API would still accept the deploy, so a
        # bare {username} looks healthy here and is not.
        user = json.loads(settings_res.read()).get("user") or {}
        if user.get("permissions") != "*":
            return False, (f"editor session reports permissions={user.get('permissions')!r} for an "
                           "Administrator; expected '*'. The Deploy button will show a padlock. "
                           "adminAuth.users must return permissions, and the map backing it must "
                           "be persisted -- an in-memory one is empty after every restart.")

        flows_res = fetch(f"{NODERED_BASE_URL}/flows",
                          headers={"Authorization": f"Bearer {editor_token}"})
        if flows_res.status != 200:
            return False, f"editor session cannot read the flows: GET /flows -> {flows_res.status}."

        return True, ("admin@aber.local signed in through Supabase Auth; the editor session "
                      "reads /settings and /flows and carries permissions='*' (Deploy enabled).")
    except Exception as err:
        return False, f"{type(err).__name__}: {err}"


def get_timescaledb_connection():
    return psycopg2.connect(
        host=TIMESCALEDB_HOST,
        port=TIMESCALEDB_PORT,
        database=TIMESCALEDB_NAME,
        user=TIMESCALEDB_USER,
        password=TIMESCALEDB_PASS
    )


def get_supabase_admin_connection():
    """A direct owner connection to the Supabase database, used only to clear this run's audit rows.
    public.digital_thread is append-only for every application role, `service_role` included, so
    clearing fixture rows needs owner authority; the trigger exempts `postgres` because a role that
    can issue DDL can drop the trigger anyway.
    """
    return psycopg2.connect(
        host=SUPABASE_DB_HOST,
        port=SUPABASE_DB_PORT,
        database=SUPABASE_DB_NAME,
        user=SUPABASE_DB_USER,
        password=SUPABASE_DB_PASS,
    )


def preflight_supabase_admin():
    """Prove the owner connection works before the suite runs. Returns True if it is usable. The owner
    connection is configured by its own SUPABASE_DB_* variables and used only at cleanup, whose
    failures are swallowed, so a wrong value would leave fixture audit rows behind silently. It
    tests authority, not reachability: `service_role` connects and is refused by the append-only
    trigger, so the check performs the real DELETE inside a transaction and rolls it back.
    """
    label = f"{SUPABASE_DB_USER}@{SUPABASE_DB_HOST}:{SUPABASE_DB_PORT}/{SUPABASE_DB_NAME}"
    try:
        conn = get_supabase_admin_connection()
    except Exception as exc:
        print(f"❌ PREFLIGHT: cannot reach the Supabase database as the owner ({label}).")
        print(f"   {exc}")
        print("   Set SUPABASE_DB_HOST / SUPABASE_DB_PORT / SUPABASE_DB_NAME / SUPABASE_DB_USER /")
        print("   POSTGRES_PASSWORD. From the HOST the port is 54322 (the dev loop forwards it");
        print("   there to avoid colliding with a local PostgreSQL); IN-CLUSTER it is 5432 and the")
        print("   host is `supabase-db`. Without this, audit-row cleanup cannot run.")
        return False

    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM public.digital_thread LIMIT 1")
                row = cur.fetchone()
                if row is None:
                    # Nothing to test against. Connectivity is proven; authority is not, and saying
                    # so is better than implying a check that did not happen.
                    print(f"⚠️  PREFLIGHT: connected as {label}, but digital_thread is empty, so")
                    print("   DELETE authority could not be exercised.")
                    return True
                cur.execute("DELETE FROM public.digital_thread WHERE id = %s", (row[0],))
                # Never committed. The row is untouched; only the trigger's verdict was wanted.
                conn.rollback()
    except Exception as exc:
        print(f"❌ PREFLIGHT: connected as {label}, but it cannot DELETE from digital_thread.")
        print(f"   {exc}")
        print("   0003's append-only trigger refuses every application role including service_role,")
        print("   and exempts the table owner. SUPABASE_DB_USER must be that owner (`postgres`),")
        print("   not a Supabase API role.")
        return False
    finally:
        conn.close()

    print(f"✅ PREFLIGHT: owner connection usable ({label}); audit cleanup will succeed.")
    return True

def cleanup_validation_data():
    print("Cleaning up validation data...")
    if supabase_client:
        try:
            # Audit rows are keyed by entity_id, and log_digital_thread_event() writes only
            # 'devices' / 'gateways' / 'cells' into entity_type, so the ids have to be collected
            # while the rows carrying the VALIDATE_ names still exist.
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
            # digital_thread would wipe the whole audit history. Routed through the owner connection
            # because the append-only trigger refuses DELETE for service_role, and kept out of the
            # surrounding try's generic handler so a failure here is reported rather than printed
            # among routine noise.
            if stale_ids:
                try:
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
                except Exception as audit_err:
                    print(f"❌ AUDIT CLEANUP FAILED: {len(stale_ids)} entity id(s) left behind in "
                          f"public.digital_thread -- {audit_err}")
                    print("   These rows are append-only and cannot be removed through PostgREST. "
                          "Clear them with an owner connection, or the next run starts dirty.")
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

def set_metric_value(metric, val):
    """Populate a Sparkplug metric's value and datatype from a Python value."""
    if isinstance(val, bool):
        metric.boolean_value = val
        metric.datatype = 11
    elif isinstance(val, (int, float)):
        metric.double_value = float(val)
        metric.datatype = 10
    elif isinstance(val, str):
        metric.string_value = val
        metric.datatype = 12


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
        set_metric_value(m, val)

    return payload.SerializeToString()


def make_aliased_birth_payload(asset_id, aliased_metrics, timestamp_ms):
    """A birth certificate that binds each metric to an integer alias, as an optimised gateway does.
    `aliased_metrics` is {name: (alias, value)}; both name and alias are present here, and the DATA
    that follows carries the alias alone.
    """
    payload = sparkplug_b_pb2.Payload()
    payload.timestamp = timestamp_ms

    m_asset = payload.metrics.add()
    m_asset.name = "Asset_ID"
    m_asset.string_value = asset_id
    m_asset.datatype = 12

    for name, (alias, val) in aliased_metrics.items():
        m = payload.metrics.add()
        m.name = name
        m.alias = alias
        m.timestamp = timestamp_ms
        set_metric_value(m, val)

    return payload.SerializeToString()


def make_alias_only_payload(metrics_by_alias, timestamp_ms):
    """A DATA payload carrying aliases and no names, what a real Sparkplug gateway publishes once it
    has birthed. No Asset_ID either: the topic is the only identity available, which is the
    realistic case.
    """
    payload = sparkplug_b_pb2.Payload()
    payload.timestamp = timestamp_ms

    for alias, val in metrics_by_alias.items():
        m = payload.metrics.add()
        m.alias = alias
        m.timestamp = timestamp_ms
        set_metric_value(m, val)

    return payload.SerializeToString()


def make_node_birth_payload(aliased_metrics, timestamp_ms):
    """An NBIRTH declaring node-level aliases. No Asset_ID: node topics carry no device."""
    payload = sparkplug_b_pb2.Payload()
    payload.timestamp = timestamp_ms

    for name, (alias, val) in aliased_metrics.items():
        m = payload.metrics.add()
        m.name = name
        m.alias = alias
        m.timestamp = timestamp_ms
        set_metric_value(m, val)

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

    # Seed the gateway at its pinned UUID; see VAL_GW_UUID. UPSERT rather than INSERT, so a previous
    # run that died before cleanup does not make every later insert fail on the primary key.
    g_res = (
        supabase_client.table("gateways")
        .upsert(
            {"id": VAL_GW_UUID, "name": VAL_GW_NAME, "cell_id": cell_id, "status": "ONLINE"},
            on_conflict="id",
        )
        .execute()
    )
    gateway = g_res.data[0] if g_res.data else {}
    SEEDED["gateway_uuid"] = gateway.get("id")
    SEEDED["gateway_id"] = gateway.get("sparkplug_id")

    # The generated id is what the MQTT credential is named after, so a mismatch means every publish
    # below is dropped by the broker with nothing logged at either end.
    if SEEDED["gateway_id"] != VAL_GW_SPARKPLUG_ID:
        raise SystemExit(
            f"Seeded gateway sparkplug_id is {SEEDED['gateway_id']!r} but the MQTT credential is "
            f"provisioned for {VAL_GW_SPARKPLUG_ID!r}. The generated-column expression and "
            f"VAL_GW_SPARKPLUG_ID have diverged."
        )

    # Seed the registered devices. sparkplug_id is a generated column, so it comes back on the
    # insert -- these are the ids the simulated gateways will publish under.
    for label, key in (
        (VAL_KNOWN_DEVICE, "known"),
        (VAL_LEGACY_DEVICE, "legacy"),
        (VAL_MISMATCH_DEVICE, "mismatch"),
        (VAL_ALIAS_DEVICE, "alias"),
    ):
        # NO `status`: the column defaults to OFFLINE, which is what a device the broker has never
        # heard from is. Seeding ONLINE was both untrue -- nothing had published yet -- and a weaker
        # fixture, because check 10 could then not tell a device the watchdog had correctly timed
        # out from one whose birth had never registered at all. 0119 refuses the seeded row outright.
        res = supabase_client.table("devices").insert({
            "name": label,
            "gateway_id": SEEDED["gateway_uuid"],
            "is_quarantined": False
        }).execute()
        row = res.data[0] if res.data else {}
        SEEDED[key + "_uuid"] = row.get("id")
        SEEDED[key + "_id"] = row.get("sparkplug_id")

    # Seed a schema and attach it to the registered device, so birth-declared metrics have something
    # to be judged against; a device with no schema is never flagged as unmodelled. Seeded as a
    # draft, because every column but `status` is frozen on an `active` or `archived` schema, for
    # `service_role` too, and check 6d widens this schema in place to prove the unmodelled verdict
    # is derived rather than stored.
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
        # Same reason as the schema above: a draft is the editable state (archived migration 0037).
        "status": "draft",
        "schema_definition": {
            "type": "object",
            "properties": {name: {"type": "number"} for name in VAL_KPI_SCHEMA_METRICS},
            "required": VAL_KPI_SCHEMA_METRICS,
        },
    }).execute()
    SEEDED["kpi_schema_uuid"] = k_res.data[0]["id"] if k_res.data else None

    if SEEDED.get("schema_uuid") and SEEDED.get("known_uuid"):
        # devices.schema_id is still written: it is the fallback arm archived migration 0034 deliberately
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
    # MQTT 5, matching the daemon and the i3X server: the validator stands in for a physical edge
    # node and must speak what the fleet speaks. paho 1.6.1's v1 callback API is unchanged.
    client = mqtt.Client(protocol=mqtt.MQTTv5)
    # Connects as its own gateway, exactly as a physical edge node does: username ==
    # VAL_GW_SPARKPLUG_ID, confined by its own broker role to its own subtree, so a mismatch shows as
    # every publish silently dropped. Read from MQTT_VALIDATOR_*, the names the release Secret
    # carries. Not `MQTT_USER`/`MQTT_PASSWORD`, the ingestion daemon's credential, which may
    # only read and publish NCMD; sourcing them would connect as the daemon and have every publish
    # discarded by the ACL. No default password: a stale default fails invisibly.
    mqtt_user = os.getenv("MQTT_VALIDATOR_USER") or VAL_GW_SPARKPLUG_ID
    mqtt_pass = os.getenv("MQTT_VALIDATOR_PASSWORD") or ""
    if not mqtt_pass:
        raise SystemExit(
            "MQTT_VALIDATOR_PASSWORD is not set.\n"
            "  This publisher connects as its own gateway and the broker runs allow_anonymous\n"
            "  false, so without it every publish is refused and the suite reports failures about\n"
            "  telemetry, aliases and rebirth -- none of which would be the actual fault.\n"
            "  Source the stack's .env before running, or generate one with: node scripts/setup.mjs"
        )
    client.username_pw_set(mqtt_user, mqtt_pass)

    if MQTT_TLS_ENABLED:
        if MQTT_TLS_CA_FILE and not os.path.isfile(MQTT_TLS_CA_FILE):
            raise SystemExit(
                f"MQTT_TLS_ENABLED is set and MQTT_TLS_CA_FILE={MQTT_TLS_CA_FILE} does not exist.\n"
                "  The system trust store cannot verify the internal CA, so the handshake would\n"
                "  fail with an error naming neither this setting nor the file."
            )
        client.tls_set(
            ca_certs=MQTT_TLS_CA_FILE or None,
            cert_reqs=ssl.CERT_REQUIRED,
            tls_version=ssl.PROTOCOL_TLS_CLIENT,
        )
        client.tls_insecure_set(False)

    # Capture the daemon's own NCMD rebirth requests. Check 9 asserts one is issued for an unknown
    # alias and the second is suppressed, so the subscription has to be live before either.
    def on_ncmd(_client, _userdata, msg):
        CAPTURED_NCMD.append((msg.topic, msg.payload))

    client.message_callback_add("spBv1.0/+/NCMD/+", on_ncmd)

    def on_state(_client, _userdata, msg):
        CAPTURED_STATE.append((msg.topic, msg.payload, msg.retain))

    client.message_callback_add("spBv1.0/STATE/#", on_state)
    # The CONNACK return code is the point: paho's connect() completes the TCP handshake and
    # returns, and the broker's verdict on the credential arrives in this callback and nowhere else.
    # A callback that ignored it made a rejected login indistinguishable from a good one, with the
    # only line naming the cause in the broker's log.
    connack = []

    # `properties` is the v5 signature, defaulted so this stays callable under either protocol. `rc`
    # is a ReasonCodes under v5; `== 0` still holds and it prints as its reason string.
    def on_connect(c, _userdata, _flags, rc, properties=None):
        connack.append(rc)
        if rc == 0:
            c.subscribe("spBv1.0/+/NCMD/+")
            # The primary host's birth certificate is RETAINED, so it arrives on subscribe rather
            # than being waited for. A gateway does exactly this to learn, at connect, whether its
            # consumer is there -- which is the property check 15 asserts.
            c.subscribe("spBv1.0/STATE/#")

    client.on_connect = on_connect

    connected = False
    for attempt in range(5):
        try:
            client.connect(MQTT_HOST, MQTT_PORT, 60, clean_start=True)
            connected = True
            break
        except Exception as e:
            print(f"MQTT connect attempt {attempt+1} failed: {e}. Retrying...")
            time.sleep(2)

    if not connected:
        print("Failed to connect to MQTT broker.")
        return

    client.loop_start()

    # Nothing may be published until the broker has accepted the connection, so an authentication
    # failure becomes one line naming the credential.
    for _ in range(50):
        if connack:
            break
        time.sleep(0.1)

    if not connack:
        raise SystemExit(
            f"MQTT: no CONNACK from {MQTT_HOST}:{MQTT_PORT} within 5s. The socket opened, so the\n"
            "  broker is reachable but never answered the CONNECT -- check the mosquitto logs."
        )
    if connack[0] != 0:
        # 4 and 5 are the two this produces: bad username/password, and not-authorised. Both mean
        # the credential, not the topic ACL, whose refusal happens later, per publish, silently.
        meaning = {
            1: "unacceptable protocol version",
            2: "identifier rejected",
            3: "server unavailable",
            4: "bad username or password",
            5: "not authorised",
        }.get(connack[0], "unknown")
        raise SystemExit(
            f"MQTT: broker refused the connection (CONNACK {connack[0]}: {meaning}).\n"
            f"  Connected as '{mqtt_user}' using MQTT_VALIDATOR_USER/MQTT_VALIDATOR_PASSWORD.\n"
            "  That account is provisioned at broker boot from the same release Secret, so this\n"
            "  means the two have diverged -- restart the broker (kubectl rollout restart\n"
            "  deploy/mosquitto) after confirming the Secret."
        )

    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    gw = SEEDED.get("gateway_id") or VAL_GW_NAME

    def publish(msg_type, device_id, metrics, asset_id=None, asset_name=None):
        """Publish under `device_id`. asset_id overrides the Asset_ID metric to force a mismatch."""
        payload = make_sparkplug_payload(asset_id or device_id, metrics, now_ms, asset_name)
        client.publish(f"spBv1.0/{VAL_GROUP}/{msg_type}/{gw}/{device_id}", payload)
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

    # 4. DBIRTH under a truncated id: quarantined with a message naming the length mismatch, which
    # is the point of the fixed 24-character format.
    print(f"\n--- DBIRTH from a malformed (23-character) device id: {MALFORMED_DEVICE_ID} ---")
    publish("DBIRTH", MALFORMED_DEVICE_ID, {"firmware": "v1.0.0"}, asset_name=VAL_MALFORMED_DEVICE)

    # 5. DDATA whose topic and Asset_ID metric disagree -> the topic wins and the device is
    #    quarantined, rather than the metric silently deciding which asset this is.
    print(f"\n--- DDATA with contradictory Asset_ID: {VAL_MISMATCH_DEVICE} ---")
    publish("DBIRTH", SEEDED["mismatch_id"], {"firmware": "v1.0.0"}, asset_id=UNKNOWN_DEVICE_ID)

    # 6. Legacy device still publishing its name: resolved by name during the migration window and
    # flagged identity_source = 'legacy_name'. The birth records how the device was resolved, so it
    # is sent before the DDATA.
    print(f"\n--- DBIRTH/DDATA from a legacy name-addressed device: {VAL_LEGACY_DEVICE} ---")
    publish("DBIRTH", VAL_LEGACY_DEVICE, {"firmware": "v0.9.0"})
    publish("DDATA", VAL_LEGACY_DEVICE, {"Systems/TEMPERATURE": 30.0, "Controller/EXECUTION": "ACTIVE"})

    # 7. DBIRTH for the registered device declaring one metric its schema does not model. Published
    # twice, identically: the daemon must record the declared set the first time and write nothing
    # the second, since log_digital_thread_event() fires on every UPDATE to `devices`.
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
        # The sentinel goes on a local test metric rather than Controller/EXECUTION, whose values
        # MTConnect constrains.
        publish("DDATA", SEEDED["known_id"],
                {"Systems/TEMPERATURE": 43.5, "VALIDATE/RENAME_SENTINEL": "RUNNING_AFTER_RENAME"})

    # 9. Sparkplug B alias resolution. Sparkplug binds each metric name to an integer alias in a
    # BIRTH and thereafter publishes DATA carrying the alias alone. Three steps, each testing a
    # rule: 9.1 NBIRTH declares an alias at node level and resets the node's table; 9.2 DBIRTH
    # declares two more at device level and merges; 9.3 alias-only DDATA uses all three, including
    # the node-declared one, which resolves only if the table is keyed per edge node.
    alias_dev = SEEDED.get("alias_id")
    if alias_dev:
        print(f"\n--- NBIRTH declaring a NODE-scoped alias on edge node {gw} ---")
        client.publish(
            f"spBv1.0/{VAL_GROUP}/NBIRTH/{gw}",
            make_node_birth_payload(
                {ALIAS_NODE_METRIC: (ALIAS_NODE_SCOPED, "NODE_BIRTH_VALUE")}, now_ms
            ),
        )
        time.sleep(2)

        print(f"\n--- DBIRTH declaring DEVICE-scoped aliases for {VAL_ALIAS_DEVICE} ---")
        client.publish(
            f"spBv1.0/{VAL_GROUP}/DBIRTH/{gw}/{alias_dev}",
            make_aliased_birth_payload(alias_dev, {
                "Systems/TEMPERATURE": (ALIAS_TEMPERATURE, 21.0),
                "Controller/EXECUTION": (ALIAS_EXECUTION, "READY"),
            }, now_ms),
        )
        time.sleep(2)

        print("\n--- Alias-only DDATA: no metric names on the wire at all ---")
        client.publish(
            f"spBv1.0/{VAL_GROUP}/DDATA/{gw}/{alias_dev}",
            make_alias_only_payload({
                ALIAS_TEMPERATURE: 66.6,
                ALIAS_EXECUTION: "ACTIVE",
                ALIAS_NODE_SCOPED: "RESOLVED_VIA_NODE_TABLE",
            }, now_ms + 1000),
        )
        time.sleep(3)

        # 10. Rebirth on an unknown alias, and its rate limit. The alias table is in-memory, so
        # asking is the only recovery after a restart, but the second request inside the window must
        # be suppressed or a gateway that reboots on rebirth is held in a loop.
        SEEDED["ncmd_baseline"] = len(CAPTURED_NCMD)
        print(f"\n--- DDATA carrying an undeclared alias ({ALIAS_UNDECLARED}) -> expect one NCMD ---")
        client.publish(
            f"spBv1.0/{VAL_GROUP}/DDATA/{gw}/{alias_dev}",
            make_alias_only_payload({ALIAS_UNDECLARED: 1.0}, now_ms + 2000),
        )
        time.sleep(3)
        SEEDED["ncmd_after_first"] = len(CAPTURED_NCMD)

        print(f"\n--- A second undeclared alias immediately after -> expect NO further NCMD ---")
        client.publish(
            f"spBv1.0/{VAL_GROUP}/DDATA/{gw}/{alias_dev}",
            make_alias_only_payload({ALIAS_UNDECLARED_SECOND: 2.0}, now_ms + 3000),
        )
        time.sleep(3)
        SEEDED["ncmd_after_second"] = len(CAPTURED_NCMD)

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
                # What was there instead, said at the moment we looked. Three different bugs produce
                # the line above: the row was never inserted, it exists with a different
                # reported_identity, or it exists with is_quarantined false. It has to be here
                # rather than in CI, because the cleanup below runs in a `finally` and anything that
                # queries afterwards finds nothing.
                try:
                    probe = supabase_client.table("devices").select(
                        "name,sparkplug_id,reported_identity,is_quarantined,quarantine_reason"
                    ).like("name", "VALIDATE%").execute()
                    rows = probe.data if probe else []
                    if rows:
                        print(f"      -> {len(rows)} VALIDATE% device row(s) present:")
                        for r in rows:
                            print(
                                f"         name={r.get('name')!r} sparkplug_id={r.get('sparkplug_id')} "
                                f"reported_identity={r.get('reported_identity')} "
                                f"quarantined={r.get('is_quarantined')} reason={r.get('quarantine_reason')}"
                            )
                    else:
                        print("      -> no VALIDATE% device rows at all: the DBIRTH never became a row.")
                except Exception as probe_err:
                    print(f"      -> could not read the devices table to say what was there: {probe_err}")
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

        # 5. asset_config must be populated from the birth certificate. The regression guard for a
        # store_birth_parameters() that raised on every DBIRTH, swallowed by process_dbirth's
        # except.
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

            # 6c. The verdict is derived, never stored: exactly VAL_UNMODELLED_METRIC must come out
            # as unmodelled, while VAL_KPI_METRIC, modelled only by the second submodel, must not.
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

            # 6d. Widening the schema must clear the finding immediately, with no rebirth from the
            # device.
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

        # 6e. The modelled set is the union across every attached submodel, asserted by showing the
        # same metric flips verdict depending on whether the second submodel is counted.
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

        # 2. Verify Digital Thread triggers. Scoped to the entities this run created; asserting the
        # whole table is non-empty would pass on audit rows from any source. Both actions are
        # required because log_digital_thread_event() serves INSERT, UPDATE and DELETE, and the run
        # performs the first two.
        try:
            run_entity_ids = [
                SEEDED[key] for key in ("cell_uuid", "gateway_uuid", "known_uuid", "legacy_uuid",
                                        "mismatch_uuid", "alias_uuid")
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

    # 7. Verify Node-RED refuses unauthenticated callers. An end-to-end check because the fix is
    # spread across a generated settings.js, an image carrying the modules it requires, and an init
    # script that reconciles the file onto an existing volume. The three probes are not redundant:
    # adminAuth covers httpAdminRoot and httpNodeAuth covers httpNodeRoot, separate Express mounts,
    # so a settings.js declaring only the first leaves the webhook receiver open.
    try:
        probes = [
            ("GET", "/flows", None, "admin API read"),
            ("POST", "/flows", b"[]", "admin API write"),
            ("POST", "/hooks/quarantine", b"{}", "quarantine webhook receiver"),
        ]
        unauthenticated = []
        for method, path, body, label in probes:
            req = urllib.request.Request(
                f"{NODERED_BASE_URL}{path}", data=body, method=method,
                headers={"Content-Type": "application/json"},
            )
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    status = resp.status
            except urllib.error.HTTPError as http_err:
                status = http_err.code
            # 401 is the expected answer. A 2xx served an unauthenticated caller; a 5xx says the
            # request got past authentication and failed behind it.
            if status != 401:
                unauthenticated.append(f"{method} {path} -> {status} ({label})")

        if not unauthenticated:
            print("✅ 7. NODE-RED AUTHENTICATION: admin API and webhook receiver both answer 401 "
                  "to unauthenticated callers.")
            # 7b. And that a real sign-in still works. Node-RED's editor resolves the user twice,
            # adminAuth.authenticate at login and adminAuth.users on every request after it, and a
            # settings.js providing only the first logs in and then 401s the entire editor. So this
            # drives the real browser handshake and asks a question only a working editor session
            # can answer.
            ok_login, detail = probe_nodered_editor_login()
            if ok_login:
                print(f"✅ 7b. NODE-RED EDITOR SIGN-IN: {detail}")
            else:
                print(f"❌ 7b. NODE-RED EDITOR SIGN-IN FAIL: {detail}")
                passed = False
        else:
            print("❌ 7. NODE-RED AUTHENTICATION FAIL: " + "; ".join(unauthenticated))
            print("      Expected 401 from each. Check that node-red and node-red-init both build "
                  "from node-red/Dockerfile, and that /data/settings.js declares adminAuth AND "
                  "httpNodeAuth (node-red-init rewrites it when they are missing).")
            passed = False
    except Exception as e:
        # Distinguished from a failed assertion on purpose: this is "could not reach Node-RED",
        # which is a different finding from "Node-RED let me in".
        print(f"❌ 7. NODE-RED AUTHENTICATION ERROR: could not probe {NODERED_BASE_URL}: {e}")
        passed = False

    # 8. Sparkplug B alias resolution: the regression guard for a daemon that read only
    # `metric.name` and ingested nothing from an alias-optimised gateway. Every assertion is on the
    # resolved name; row counts alone would pass on rows named "".
    alias_key = SEEDED.get("alias_id")
    if alias_key:
        try:
            conn = get_timescaledb_connection()
            cur = conn.cursor()
            cur.execute(
                "SELECT metric_name, val_double, val_string FROM telemetry WHERE asset_id = %s;",
                (alias_key,)
            )
            rows = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
            conn.close()

            if "Systems/TEMPERATURE" in rows and rows["Systems/TEMPERATURE"][0] == 66.6:
                print("✅ 8. ALIAS RESOLUTION: alias-only DDATA resolved to its birth-declared "
                      "metric name and landed in the historian.")
                print(f"      -> Systems/TEMPERATURE = {rows['Systems/TEMPERATURE'][0]} "
                      f"(published as alias {ALIAS_TEMPERATURE}, no name on the wire)")
            else:
                print("❌ 8. ALIAS RESOLUTION FAIL: no 'Systems/TEMPERATURE' row for "
                      f"'{alias_key}'. Metrics published by alias alone are being dropped; the "
                      f"historian holds {sorted(rows)}.")
                passed = False

            # 8a. A string-valued metric through the same path, so the check is not passing on
            # one datatype's code path alone.
            if rows.get("Controller/EXECUTION", (None, None))[1] == "ACTIVE":
                print("✅ 8a. ALIAS RESOLUTION (string): 'Controller/EXECUTION' resolved to ACTIVE.")
            else:
                print(f"❌ 8a. ALIAS RESOLUTION (string) FAIL: got "
                      f"{rows.get('Controller/EXECUTION')}, expected 'ACTIVE'.")
                passed = False

            # 8b. The one that pins the scope: this alias was declared by the gateway's NBIRTH and
            # used by a device's DDATA, so a per-device table would resolve 8 and 8a and fail only
            # here.
            if rows.get(ALIAS_NODE_METRIC, (None, None))[1] == "RESOLVED_VIA_NODE_TABLE":
                print("✅ 8b. NODE-SCOPED ALIASES: an alias declared in the gateway's NBIRTH "
                      "resolved for a DEVICE's DDATA — the table is keyed per edge node.")
            else:
                print(f"❌ 8b. NODE-SCOPED ALIASES FAIL: '{ALIAS_NODE_METRIC}' is absent or wrong "
                      f"({rows.get(ALIAS_NODE_METRIC)}). The alias table looks device-scoped; a "
                      "device cannot then use an alias its own edge node declared.")
                passed = False

            # 8c. An undecodable metric must not become a nameless row; the daemon skips it and asks
            # for a rebirth (check 9).
            if "" not in rows and None not in rows:
                print("✅ 8c. NO NAMELESS ROWS: unresolvable aliases were skipped, not written "
                      "under an empty metric name.")
            else:
                print("❌ 8c. NO NAMELESS ROWS FAIL: the historian holds a row with no metric name.")
                passed = False
        except Exception as e:
            print(f"❌ 8. ALIAS RESOLUTION ERROR: {e}")
            passed = False
    else:
        print("⚠️  8. ALIAS RESOLUTION: skipped, the alias fixture device was not seeded.")

    # 9. NCMD rebirth request, and its rate limit. This closes the alias cold start after an
    # ingestion restart. The second half is an assertion about a message that must not appear.
    try:
        baseline = SEEDED.get("ncmd_baseline")
        after_first = SEEDED.get("ncmd_after_first")
        after_second = SEEDED.get("ncmd_after_second")
        expected_topic = f"spBv1.0/{VAL_GROUP}/NCMD/{SEEDED.get('gateway_id')}"
        ours = [(t, p) for t, p in CAPTURED_NCMD if t == expected_topic]

        if baseline is None:
            print("⚠️  9. REBIRTH REQUEST: skipped, the alias fixture device was not seeded.")
        elif after_first > baseline and ours:
            print(f"✅ 9. REBIRTH REQUEST: an unknown alias produced an NCMD on {expected_topic}.")

            # 9a. It must actually be a rebirth command, not merely traffic on the topic.
            body = sparkplug_b_pb2.Payload()
            body.ParseFromString(ours[-1][1])
            names = [m.name for m in body.metrics]
            if "Node Control/Rebirth" in names:
                print("✅ 9a. REBIRTH PAYLOAD: carries the 'Node Control/Rebirth' metric.")
            else:
                print(f"❌ 9a. REBIRTH PAYLOAD FAIL: metrics were {names}; expected "
                      "'Node Control/Rebirth'.")
                passed = False

            # 9b. The rate limit: a second unknown alias immediately after must produce nothing, or
            # a gateway that answers a rebirth by restarting would be held in a loop.
            if after_second == after_first:
                print(f"✅ 9b. REBIRTH RATE LIMIT: a second unknown alias inside the "
                      f"{os.getenv('REBIRTH_REQUEST_INTERVAL_SECONDS', '300')}s window produced "
                      "no further request.")
            else:
                print(f"❌ 9b. REBIRTH RATE LIMIT FAIL: {after_second - after_first} additional "
                      "NCMD(s) were published inside the window. An unresponsive gateway will be "
                      "asked once per message.")
                passed = False
        else:
            # THE THROTTLE 9b ASSERTS IS ALSO THE COMMONEST REASON 9 FAILS, and the two are
            # indistinguishable from here: a suppressed request and an absent one both look like
            # an empty capture. Named first, because the alternative reading is alarming and the
            # daemon's log settles it in one line.
            interval = os.getenv("REBIRTH_REQUEST_INTERVAL_SECONDS", "300")
            print("❌ 9. REBIRTH REQUEST FAIL: DDATA carrying an undeclared alias produced no "
                  f"NCMD on {expected_topic}.")
            print(f"      -> RULE OUT THE THROTTLE FIRST: a rebirth is asked once per edge node "
                  f"per {interval}s, so a run started inside that window of a previous one fails "
                  "here against a daemon that is working perfectly. The daemon's log states the "
                  "deadline -- grep it for 'REBIRTH REQUESTED' and compare the timestamp with "
                  "this run, then wait the window out rather than re-running.")
            print("      -> If the window was clear, this is the real fault: an ingestion restart "
                  "silently stops recording every alias-optimised device until its gateway is "
                  "power-cycled.")
            passed = False
    except Exception as e:
        print(f"❌ 9. REBIRTH REQUEST ERROR: {e}")
        passed = False

    # 10. Device liveness watchdog. A device that stops publishing emits no DDEATH, so without the
    # watchdog it stays ONLINE forever. Conditional on the configured window, because the default is
    # 300s.
    if not supabase_client or not SEEDED.get("alias_uuid"):
        print("⚠️  10. DEVICE WATCHDOG: skipped, no Supabase client or fixture device.")
    elif WATCHDOG_TIMEOUT <= 0:
        print("⚠️  10. DEVICE WATCHDOG: skipped, disabled (DEVICE_OFFLINE_TIMEOUT_SECONDS=0).")
    elif WATCHDOG_TIMEOUT > WATCHDOG_MAX_WAIT_SECONDS:
        print(f"⚠️  10. DEVICE WATCHDOG: skipped. The configured window is {WATCHDOG_TIMEOUT}s and "
              f"this check will only wait {WATCHDOG_MAX_WAIT_SECONDS}s. To exercise it, restart "
              "the ingestion service with DEVICE_OFFLINE_TIMEOUT_SECONDS=45 and re-run. The sweep "
              "logic itself is covered by ingestion/test_declared_metrics.py.")
    else:
        try:
            wait = WATCHDOG_TIMEOUT + WATCHDOG_INTERVAL + 5
            print(f"\n--- 10. Waiting {wait}s for the watchdog to notice "
                  f"{VAL_ALIAS_DEVICE} has gone quiet ---")
            time.sleep(wait)

            res = supabase_client.table("devices").select("status").eq(
                "id", SEEDED["alias_uuid"]
            ).execute()
            status = res.data[0]["status"] if res.data else None

            if status == "OFFLINE":
                print(f"✅ 10. DEVICE WATCHDOG: a device quiet for over {WATCHDOG_TIMEOUT}s with no "
                      "DDEATH was marked OFFLINE.")
            else:
                print(f"❌ 10. DEVICE WATCHDOG FAIL: status is '{status}' after {wait}s of silence; "
                      "expected OFFLINE. Check that the ingestion container has the same "
                      "DEVICE_OFFLINE_TIMEOUT_SECONDS this shell does.")
                passed = False

            # 10a. Written once, not once per sweep tick: log_digital_thread_event() fires on every
            # UPDATE to `devices`, so a watchdog rewriting OFFLINE each tick would append to the
            # audit table forever.
            audit = supabase_client.table("digital_thread").select("id,new_data").eq(
                "entity_id", SEEDED["alias_uuid"]
            ).eq("action", "UPDATE").execute()
            offline_rows = [
                r for r in (audit.data or [])
                if (r.get("new_data") or {}).get("status") == "OFFLINE"
            ]
            if len(offline_rows) <= 1:
                print(f"✅ 10a. WRITE-ON-CHANGE: {len(offline_rows)} OFFLINE audit row written, not "
                      "one per sweep tick.")
            else:
                print(f"❌ 10a. WRITE-ON-CHANGE FAIL: {len(offline_rows)} OFFLINE audit rows for one "
                      "quiet period. The watchdog is rewriting an unchanged status and filling an "
                      "append-only table.")
                passed = False
        except Exception as e:
            print(f"❌ 10. DEVICE WATCHDOG ERROR: {e}")
            passed = False

    # 11. Factory+ Directory adapter. These routes are exempt from the gateway's key-auth and the
    # edge function is the only thing in front of the data, so check 11b is the security assertion
    # for the whole surface. Probed with raw urllib rather than the Supabase client, which would
    # attach an apikey and token automatically.
    try:
        def probe(path, headers=None):
            req = urllib.request.Request(f"{SUPABASE_URL}{path}", headers=headers or {})
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    return resp.status, resp.read().decode()
            except urllib.error.HTTPError as err:
                return err.code, err.read().decode()

        # 11a. /ping must answer WITHOUT an apikey. The Factory+ component specification requires
        # it for discovery, and the gateway's key check would otherwise refuse it.
        status, body = probe("/ping")
        if status == 200 and '"service"' in body and "fplus-directory" in body:
            print("✅ 11. DIRECTORY /ping: answers 200 with no apikey and no bearer token.")
        else:
            print(f"❌ 11. DIRECTORY /ping FAIL: HTTP {status}, body {body[:160]}. Expected 200. "
                  "A 401 means the route is still behind the gateway's key check; a 404 means the function "
                  "is not registered in supabase/functions/main/index.ts.")
            passed = False

        # 11b. THE ONE THAT MATTERS. Anonymous /v1/device must be refused BY THE FUNCTION, since
        # the gateway is not gating it.
        status, body = probe("/v1/device")
        if status == 401:
            print("✅ 11b. DIRECTORY FAIL-CLOSED: anonymous /v1/device answers 401.")
        else:
            print(f"❌ 11b. DIRECTORY FAIL-CLOSED FAIL: anonymous /v1/device answered {status}. "
                  "These routes are exempt from the gateway's key check, so the function's own token "
                  "check is the ONLY thing in front of the whole address space.")
            passed = False

        # 11c. And it must actually work for an authenticated caller.
        anon = SUPABASE_PUBLISHABLE_KEY
        token = None
        try:
            req = urllib.request.Request(
                f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
                data=json.dumps({"email": "admin@aber.local",
                                 "password": "aber123"}).encode(),
                headers={"apikey": anon, "Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                token = json.loads(resp.read())["access_token"]
        except Exception as auth_err:
            print(f"⚠️  11c. DIRECTORY AUTHENTICATED READ: skipped, could not sign in ({auth_err}).")

        if token:
            status, body = probe("/v1/device", {"Authorization": f"Bearer {token}"})
            try:
                parsed = json.loads(body)
            except Exception:
                parsed = None

            # A UUID list, matching the Factory+ Directory's own shape. Asserting the shape and not
            # merely the status is the point.
            if status == 200 and isinstance(parsed, list) and all(
                isinstance(x, str) and len(x) == 36 for x in parsed
            ):
                print(f"✅ 11c. DIRECTORY AUTHENTICATED READ: /v1/device returned {len(parsed)} "
                      "Instance_UUID(s).")

                # 11d. And one of them resolves to a Sparkplug address, which is the mapping the
                # adapter exists to publish and the reason archived migration 0008 added the group.
                if SEEDED.get("known_uuid") and SEEDED["known_uuid"] in parsed:
                    status, body = probe(f"/v1/device/{SEEDED['known_uuid']}",
                                         {"Authorization": f"Bearer {token}"})
                    entry = json.loads(body) if status == 200 else {}
                    address = entry.get("address") or {}
                    if address.get("group_id") == VAL_GROUP and address.get("node_id") == SEEDED.get("gateway_id"):
                        print(f"✅ 11d. DIRECTORY ADDRESS MAPPING: the device resolves to "
                              f"{address['group_id']}/{address['node_id']}/{address.get('device_id')}.")
                    else:
                        print(f"❌ 11d. DIRECTORY ADDRESS MAPPING FAIL: got {address}, expected group "
                              f"'{VAL_GROUP}' and node '{SEEDED.get('gateway_id')}'.")
                        passed = False
                else:
                    print("⚠️  11d. DIRECTORY ADDRESS MAPPING: skipped, this run's device is not in "
                          "the listing.")

                # 11e. The reverse lookup: an address resolves to the edge node and its devices.
                status, body = probe(f"/v1/address/{VAL_GROUP}/{SEEDED.get('gateway_id')}",
                                     {"Authorization": f"Bearer {token}"})
                node = json.loads(body) if status == 200 else {}
                if status == 200 and node.get("uuid") == SEEDED.get("gateway_uuid"):
                    print(f"✅ 11e. DIRECTORY ADDRESS LOOKUP: /v1/address resolved the edge node and "
                          f"{len(node.get('devices') or [])} device(s) behind it.")
                else:
                    print(f"❌ 11e. DIRECTORY ADDRESS LOOKUP FAIL: HTTP {status}, uuid "
                          f"{node.get('uuid')}, expected {SEEDED.get('gateway_uuid')}.")
                    passed = False
            else:
                print(f"❌ 11c. DIRECTORY AUTHENTICATED READ FAIL: HTTP {status}, body {body[:200]}. "
                      "Expected 200 and a JSON array of Instance_UUIDs.")
                passed = False
    except Exception as e:
        print(f"❌ 11. DIRECTORY ERROR: could not probe {SUPABASE_URL}: {e}")
        passed = False


    # 12. The i3X server. Deliberately not a conformance check: CESMII publishes a 60-test suite and
    # CI runs it. What is asserted is what the suite cannot know, because it is a property of this
    # deployment: the address space is scoped to the caller, not served from a service-role key;
    # values are the live MQTT ones rather than a database read; `/info` is reachable with no
    # credential and doubles as the container health probe; writes are refused.
    try:
        i3x_base = os.getenv("I3X_BASE_URL", "http://localhost:8090").rstrip("/") + "/v1"

        def i3x(method, path, headers=None, body=None):
            """Raw urllib, like check 11's probe -- the Supabase client would attach credentials
            automatically, which is exactly what must be ABSENT for 12b and 12f."""
            req = urllib.request.Request(
                f"{i3x_base}{path}", method=method,
                data=json.dumps(body).encode() if body is not None else None,
                headers=headers or {},
            )
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    return resp.status, resp.read().decode()
            except urllib.error.HTTPError as err:
                return err.code, err.read().decode()
            except Exception as err:
                return 0, str(err)

        # 12. Unauthenticated /info -- a spec MUST, and the health probe the chart uses.
        status, body = i3x("GET", "/info")
        info = json.loads(body) if status == 200 else {}
        result = info.get("result", info)
        if status == 200 and result.get("specVersion"):
            print(f"✅ 12.  i3X SERVER: /info answers unauthenticated, specVersion "
                  f"{result['specVersion']}, serverName {result.get('serverName')}")
        else:
            print(f"❌ 12.  i3X SERVER FAIL: /info returned HTTP {status}. It MUST be reachable "
                  "with no credentials -- it is the capabilities document and the health check.")
            passed = False

        if status == 200:
            # 12a. Update is declared false AND unimplemented. Two statements of one decision: a
            # client that trusts the flag and a client that probes the verb must agree.
            caps = result.get("capabilities", {}).get("update", {})
            put_status, _ = i3x("PUT", "/objects/value",
                                {"Authorization": f"Bearer {token}",
                                 "Content-Type": "application/json"}, {})
            if caps.get("current") is False and put_status == 405:
                print("✅ 12a. i3X READ-ONLY: update.current is false and PUT /objects/value "
                      "answers 405 -- the capability flag and the verb agree")
            else:
                print(f"❌ 12a. i3X READ-ONLY FAIL: capabilities.update.current="
                      f"{caps.get('current')}, PUT /objects/value returned {put_status}. "
                      "Expected false and 405.")
                passed = False

            # 12b. Anonymous reads are refused. /info is the ONLY open endpoint.
            anon_status, _ = i3x("GET", "/objects")
            if anon_status == 401:
                print("✅ 12b. i3X FAIL-CLOSED: an unauthenticated /objects read answers 401")
            else:
                print(f"❌ 12b. i3X FAIL-CLOSED FAIL: unauthenticated /objects returned "
                      f"{anon_status}, expected 401.")
                passed = False

            # 12c. The address space contains this run's device, and its parent is a location, a
            # cell or the synthetic Unassigned, never its gateway.
            status, body = i3x("GET", "/objects", {"Authorization": f"Bearer {token}"})
            objects = json.loads(body).get("result", []) if status == 200 else []
            device = next((o for o in objects if o.get("elementId") == SEEDED["known_id"]), None)
            gateway_ids = {o["elementId"] for o in objects
                           if o.get("typeElementId") == "i3x:type:gateway"}
            if device and device.get("parentId") not in gateway_ids:
                print(f"✅ 12c. i3X ADDRESS SPACE: {SEEDED['known_id']} is present, parented to "
                      f"{device['parentId']} (a location, not its gateway)")
            elif device:
                print(f"❌ 12c. i3X ADDRESS SPACE FAIL: the device's parentId is {device['parentId']}, "
                      "which is a gateway. HasParent is organizational hierarchy; the data path "
                      "belongs on ConnectsVia.")
                passed = False
            else:
                print(f"❌ 12c. i3X ADDRESS SPACE FAIL: {SEEDED['known_id']} is not in /objects "
                      f"({len(objects)} objects returned).")
                passed = False

            # 12d. Exactly one root: `parentId: null` means root in i3X, which is why Unassigned is
            # a synthetic object under the site rather than a second root.
            roots = [o["elementId"] for o in objects if o.get("parentId") is None]
            if roots == ["i3x:site"]:
                print("✅ 12d. i3X SINGLE ROOT: exactly one object has a null parentId (i3x:site)")
            else:
                print(f"❌ 12d. i3X SINGLE ROOT FAIL: roots are {roots}, expected ['i3x:site'].")
                passed = False

            # 12e. Values come from MQTT, not the database. Asserted by reading a metric this run
            # published and checking the timestamp is recent rather than merely present.
            status, body = i3x("POST", "/objects/value",
                               {"Authorization": f"Bearer {token}",
                                "Content-Type": "application/json"},
                               {"elementIds": [SEEDED["known_id"]]})
            results = json.loads(body).get("results", []) if status == 200 else []
            value = (results[0].get("result") or {}) if results and results[0].get("success") else {}
            metrics = value.get("value") if isinstance(value.get("value"), dict) else {}
            if metrics:
                print(f"✅ 12e. i3X LIVE VALUES: {len(metrics)} metric(s) served from the MQTT cache "
                      f"(quality {value.get('quality')}), e.g. {sorted(metrics)[:3]}")
            else:
                print(f"❌ 12e. i3X LIVE VALUES FAIL: no current value for "
                      f"{SEEDED['known_id']}. HTTP {status}, body {body[:200]}")
                passed = False

            # 12f. The RLS assertion. The value cache is a plain dict keyed by sparkplug_id with no
            # notion of policy, so a caller whose token cannot see the device must be told "not
            # found". Probed with a deliberately invalid token rather than a second user: it
            # exercises the same code path without a second seeded identity.
            status, body = i3x("POST", "/objects/value",
                               {"Authorization": "Bearer not.a.valid.token",
                                "Content-Type": "application/json"},
                               {"elementIds": [SEEDED["known_id"]]})
            leaked = SEEDED["known_id"] in body and '"value":' in body and status == 200
            if status in (401, 403) or (status == 200 and not leaked):
                print(f"✅ 12f. i3X VALUES ARE RLS-SCOPED: a caller whose token the data layer "
                      f"rejects gets no values (HTTP {status})")
            else:
                print(f"❌ 12f. i3X VALUES ARE RLS-SCOPED FAIL: HTTP {status} returned live values "
                      "to an unauthorised caller. The MQTT cache has no RLS of its own -- every "
                      "value read must be gated on a PostgREST resolve made AS THE CALLER.")
                passed = False
    except Exception as e:
        print(f"⚠️  12.  i3X SERVER: skipped, could not reach {os.getenv('I3X_BASE_URL', 'http://localhost:8090')}: {e}")

    # 13. The `anon` privilege baseline. `public.ensure_cron_job` is SECURITY DEFINER with no
    # authorisation check, and a pg_dump baseline records only positive grants, so a GRANT to `anon`
    # on it would let an unauthenticated caller schedule arbitrary SQL as `postgres`. Only asking
    # the running database as an unauthenticated caller gives a truthful answer, and this survives
    # someone re-running pg_dump.
    try:
        def anon_rpc(fn, args):
            """Call a PostgREST RPC as the anon role and nothing else. Raw urllib rather than the
            Supabase client, and the publishable key in both headers: the point is to be exactly
            the caller an attacker is.
            """
            anon_key = SUPABASE_PUBLISHABLE_KEY
            req = urllib.request.Request(
                f"{SUPABASE_URL}/rest/v1/rpc/{fn}",
                method="POST",
                data=json.dumps(args).encode(),
                headers={"apikey": anon_key,
                         "Authorization": f"Bearer {anon_key}",
                         "Content-Type": "application/json"},
            )
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    return resp.status, resp.read().decode()
            except urllib.error.HTTPError as err:
                return err.code, err.read().decode()

        status, body = anon_rpc(
            "ensure_cron_job",
            {"p_name": "validate_probe_never_runs",
             # 31 February. If the guard has regressed and this DOES schedule, it can never fire.
             "p_schedule": "0 0 31 2 *",
             "p_command": "SELECT 1"},
        )
        if status in (401, 403):
            print(f"✅ 13.  ANON CANNOT SCHEDULE CRON: rpc/ensure_cron_job refused with HTTP {status}.")
        elif status == 404:
            print("✅ 13.  ANON CANNOT SCHEDULE CRON: rpc/ensure_cron_job is not exposed at all.")
        else:
            print(f"❌ 13.  ANON CAN SCHEDULE CRON -- PRIVILEGE ESCALATION: HTTP {status}. "
                  "public.ensure_cron_job is SECURITY DEFINER with no authorisation check and "
                  "schedules SQL as the database owner (rolbypassrls, rolcreaterole). Migration "
                  f"0009 should have revoked it. Response: {body[:200]}")
            passed = False

        # The general form: a grant to `anon` on anything in `public` is the class. The allow-list
        # has exactly one entry: `auth_pre_request()` is PostgREST's `db-pre-request` hook, run
        # after switching to the request's role, which for an unauthenticated request is `anon`;
        # revoking it would take the entire anonymous API surface down. Matched on name and arity so
        # an overload cannot arrive under its cover.
        ANON_EXECUTE_ALLOWED = {("auth_pre_request", 0)}
        try:
            audit_conn = get_supabase_admin_connection()
            with audit_conn.cursor() as cur:
                cur.execute("""
                    SELECT p.proname, p.pronargs
                    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public'
                      AND has_function_privilege('anon', p.oid, 'EXECUTE')
                    ORDER BY p.proname
                """)
                found = [(name, int(nargs)) for name, nargs in cur.fetchall()]
            audit_conn.close()
            leaked = ", ".join(
                sorted(name for name, nargs in found if (name, nargs) not in ANON_EXECUTE_ALLOWED)
            )
            if leaked:
                print(f"❌ 13a. ANON PRIVILEGE BASELINE FAIL: anon can EXECUTE in public: {leaked}. "
                      "An anon privilege review must return an EMPTY set apart from the "
                      "PostgREST pre-request hook -- that is what makes a real finding visible "
                      "instead of hiding it among harmless trigger functions. A new function is "
                      "EXECUTE-able by PUBLIC unless the migration revokes it: add "
                      "`REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon;` before its GRANT.")
                passed = False
            else:
                print("✅ 13a. ANON PRIVILEGE BASELINE: anon holds no EXECUTE on any function in "
                      "public beyond the PostgREST pre-request hook, which cannot be revoked "
                      "without taking the anonymous API down.")
        except Exception as db_err:
            print(f"⚠️  13a. ANON PRIVILEGE BASELINE: skipped, no owner DB connection ({db_err}).")
    except Exception as e:
        print(f"⚠️  13.  ANON PRIVILEGE BASELINE: skipped, could not reach PostgREST: {e}")

    # 14. The gateway admits only the publishable and secret keys. The anon and service-role JWTs
    # are what it hands its upstreams; one presented as the apikey must be refused at the edge.
    if SUPABASE_SERVICE_ROLE_KEY:
        try:
            req = urllib.request.Request(
                f"{SUPABASE_URL}/rest/v1/devices?limit=1",
                headers={"apikey": SUPABASE_SERVICE_ROLE_KEY,
                         "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}"},
            )
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    status, body = resp.status, resp.read().decode()
            except urllib.error.HTTPError as err:
                status, body = err.code, err.read().decode()
            if status == 401 and "Unauthorized" in body:
                print("✅ 14.  JWT REFUSED AS APIKEY: the service-role JWT presented as the apikey "
                      "answers 401 at the gateway.")
            else:
                print(f"❌ 14.  JWT ACCEPTED AS APIKEY: HTTP {status}, body {body[:160]}. The gateway "
                      "must admit only the publishable and secret keys; the JWTs are its to "
                      "substitute, not a caller's credential.")
                passed = False
        except Exception as e:
            print(f"⚠️  14.  JWT REFUSED AS APIKEY: skipped, could not reach the gateway: {e}")
    else:
        print("⚠️  14.  JWT REFUSED AS APIKEY: skipped, SUPABASE_SERVICE_ROLE_KEY not set.")

    # 15. The Sparkplug primary host announces itself, and an ordinary gateway can read it.
    #
    # THIS IS THE CHECK THAT WOULD HAVE CAUGHT THE ORIGINAL FAULT. The broker's roles granted every
    # gateway read of `spBv1.0/STATE/#` from the beginning and nothing ever published it, so every
    # gateway on the site subscribed to a permanently empty topic (issue #149). Nothing failed: a
    # topic with no publisher and a topic whose publisher is broken look identical from here, which
    # is why it went unnoticed.
    #
    # THE CREDENTIAL IS THE POINT. This validator authenticates as a gateway account holding the
    # shared `gateway` role, so what it reads below is exactly what a physical third-party gateway
    # reads -- not what an admin or the daemon's own principal could see.
    if not PRIMARY_HOST_ID:
        print("⚠️  15.  PRIMARY HOST STATE: skipped, PRIMARY_HOST_ID not set in this environment.")
    else:
        expected_topic = f"spBv1.0/STATE/{PRIMARY_HOST_ID}"
        birth = None
        for topic, payload, retain in CAPTURED_STATE:
            if topic != expected_topic:
                continue
            try:
                doc = json.loads(payload.decode("utf-8"))
            except Exception:
                continue
            if doc.get("online") is True:
                birth = (doc, retain)
                break

        if birth is None:
            seen = sorted({t for t, _p, _r in CAPTURED_STATE})
            print(f"❌ 15.  PRIMARY HOST STATE FAIL: nothing retained on {expected_topic} said "
                  "online: true.")
            # Which of the three causes it is. A wrong host id and an absent publisher produce the
            # same silence at the subscriber, and the broker refusing the write produces it too --
            # so the topics actually seen are the one piece of evidence that separates them.
            if seen:
                print(f"      -> STATE topics that DID arrive: {', '.join(seen)}")
                print("      -> a different host id here means the daemon and this Job were given "
                      "different values; the chart passes both from one helper.")
            else:
                print("      -> no STATE topic arrived at all. Either the daemon is not publishing "
                      "it, or the broker is refusing the write: check that the `ingestion` role "
                      f"carries publishClientSend on {expected_topic}.")
            passed = False
        else:
            doc, retain = birth
            print(f"✅ 15.  PRIMARY HOST STATE: '{PRIMARY_HOST_ID}' announced itself online, and a "
                  "gateway account can read it.")
            print(f"      -> {expected_topic} online={doc.get('online')} timestamp={doc.get('timestamp')}")
            # RETAINED IS HALF THE VALUE. Without it a gateway learns the state only at the next
            # transition -- so it connects knowing nothing and stays that way, which is the failure
            # this topic exists to prevent. A retained message arrives on SUBSCRIBE, which is how
            # this one reached us at all.
            if not retain:
                print("❌ 15b. PRIMARY HOST STATE NOT RETAINED: a gateway connecting later would "
                      "see nothing until the next transition.")
                passed = False
            else:
                print("✅ 15b. RETAINED: a gateway connecting at any time learns the current state "
                      "immediately.")
            if not isinstance(doc.get("timestamp"), int):
                print(f"❌ 15c. PRIMARY HOST STATE TIMESTAMP: expected a JSON number of UTC "
                      f"milliseconds, got {doc.get('timestamp')!r}.")
                passed = False
            else:
                print("✅ 15c. TIMESTAMP: a JSON number, as 3.0.0 requires (it pairs the birth "
                      "with the death certificate).")

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

    # Print the resolved endpoints before doing anything, because both ways of misconfiguring this
    # script fail somewhere other than at the cause: from the host, an in-cluster Service name
    # resolves to nothing; in-cluster, a host left at its default points
    # it at its own pod. Supabase's own database is listed too, since only the cleanup path touches
    # it.
    print("Validation targets:")
    print(f"  MQTT broker  : {MQTT_HOST}:{MQTT_PORT}{' (TLS)' if MQTT_TLS_ENABLED else ''}")
    print(f"  TimescaleDB  : {TIMESCALEDB_HOST}:{TIMESCALEDB_PORT}/{TIMESCALEDB_NAME}")
    print(f"  Supabase DB  : {SUPABASE_DB_HOST}:{SUPABASE_DB_PORT}/{SUPABASE_DB_NAME}")
    print(f"  Supabase API : {SUPABASE_URL}")
    print(f"  Node-RED     : {NODERED_BASE_URL}")
    print(f"  Secret key   : {'set' if SUPABASE_SECRET_KEY else 'MISSING'}")
    print()

    # Checked here rather than discovered at cleanup. The suite still runs when this fails, but the
    # exit status carries the failure, because a run that cannot clear its own audit rows leaves the
    # next one seeded with this one's.
    admin_ok = preflight_supabase_admin()
    print()

    if args.cleanup:
        cleanup_validation_data()
        sys.exit(0 if admin_ok else 1)

    success = False
    try:
        cleanup_validation_data()
        seed_supabase()
        run_simulation()
        success = verify_results()
    finally:
        if not args.keep_data:
            cleanup_validation_data()

    sys.exit(0 if (success and admin_ok) else 1)
