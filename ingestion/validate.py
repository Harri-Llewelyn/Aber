import os
import re
import ssl
import sys
import time
import json
import argparse
import urllib.error
import urllib.parse
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
# The registered device's birth certificate: its schema's metrics, the unmodelled one, and the KPI
# only the second attached submodel models (check 6e). Sent by step 7, and again before check 12.
VAL_KNOWN_BIRTH = {"Systems/TEMPERATURE": 42.5, "Controller/EXECUTION": "ACTIVE",
                   "Controller/EMERGENCY_STOP": "ARMED", VAL_UNMODELLED_METRIC: 55.2,
                   VAL_KPI_METRIC: 0.92}

# The plant check 12 compares with the Directory: an area with the cell filed in it, a gateway serving
# the whole area, and two devices with two metrics each. A carries one schema, whose semantic id its
# i3X object must name; B inherits nothing, sits in the cell by its own cell_id, and publishes a
# signed Int32 below zero. Metrics are {name: (Sparkplug datatype, birth value, data value)}.
VAL_AREA_NAME = "VALIDATE Area 1"
VAL_AREA_GW_NAME = "VALIDATE_Area_Gateway_01"
VAL_PLANT_A_DEVICE = "VALIDATE_Plant_Device_A"
VAL_PLANT_B_DEVICE = "VALIDATE_Plant_Device_B"
VAL_PLANT_SCHEMA_NAME = "VALIDATE_Schema_Plant"
VAL_PLANT_SCHEMA_SEMANTIC_ID = "urn:aber:validate:plant-device"
VAL_SIGNED_METRIC = "VALIDATE/SIGNED_INT32"
VAL_SIGNED_DATA_VALUE = -42
VAL_PLANT_METRICS = {
    "plant_a": {"Systems/TEMPERATURE": (10, 20.5, 21.0), "Controller/EXECUTION": (12, "READY", "ACTIVE")},
    "plant_b": {"Systems/TEMPERATURE": (10, 18.25, 18.5), VAL_SIGNED_METRIC: (3, -5, VAL_SIGNED_DATA_VALUE)},
}
# Plant device A's DATA after the first, a second apart: one metric alone, then the other, so its
# history holds a value carried forward and a metric with two samples.
VAL_PLANT_LATER = {"plant_a": ({"Controller/EXECUTION": "STOPPED"}, {"Systems/TEMPERATURE": 21.5})}
# A device of its own for check 12z, which archives it: no other check may see it leave.
VAL_WITHDRAWN_DEVICE = "VALIDATE_Withdrawn_Device_001"
VAL_SUBSCRIPTION_CLIENT = "validate-withdrawal"
# The clientId check 17's subscriptions are made under; each is deleted by the check that made it.
VAL_LIVE_CLIENT = "validate-live"
# Never components of a device: wire plumbing, as i3x_service.IDENTITY_METRICS has it.
IDENTITY_METRICS = {"Asset_ID", "Asset_Name", "Instance_UUID", "Schema_UUID"}

# A well-formed device id that is deliberately not registered: 'dev' + 21 hex = 24 characters.
UNKNOWN_DEVICE_ID = "dev" + "f" * 21
# The same id one character short -- the truncation case the format check exists to diagnose.
MALFORMED_DEVICE_ID = "dev" + "f" * 20

# The Sparkplug Group ID every message in this run is published under; the alias table and the
# rebirth topic are both scoped by it. Must match gateways.sparkplug_group, which defaults to the
# site's group (0131), or every check would exercise the deprecated fallback arm.
VAL_GROUP = os.getenv("SPARKPLUG_GROUP", "Aber")

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

# Populated by seed_supabase() and run_simulation(). `<key>_uuid` is a row's id, and for a gateway or a
# device `<key>_id` is its sparkplug_id, which a device's historian rows are keyed by. The cleanup
# deletes what this names, so every row a run creates goes in here, its key in SEEDED_TABLES.
SEEDED = {}
SEEDED_TABLES = {
    "area": "areas",
    "cell": "cells",
    "gateway": "gateways",
    "area_gateway": "gateways",
    "known": "devices",
    "legacy": "devices",
    "mismatch": "devices",
    "alias": "devices",
    "plant_a": "devices",
    "plant_b": "devices",
    "withdrawn": "devices",
    "quarantined": "devices",
    "malformed": "devices",
    "schema": "schemas",
    "kpi_schema": "schemas",
    "plant_schema": "schemas",
}
# Children before parents: a gateway or device naming an area refuses the area's DELETE.
CLEANUP_ORDER = ("devices", "gateways", "cells", "areas", "schemas")


def seeded_keys(table):
    """The SEEDED keys naming a row of `table` that this run created."""
    return [key for key, kind in SEEDED_TABLES.items() if kind == table and SEEDED.get(key + "_uuid")]

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
    public.audit_trail is append-only for every application role, `service_role` included, so
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
        print("   POSTGRES_PASSWORD. From the HOST the port is 54322 (the dev loop forwards it")
        print("   there to avoid colliding with a local PostgreSQL); IN-CLUSTER it is 5432 and the")
        print("   host is `supabase-db`. Without this, audit-row cleanup cannot run.")
        return False

    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM public.audit_trail LIMIT 1")
                row = cur.fetchone()
                if row is None:
                    # Nothing to test against. Connectivity is proven; authority is not, and saying
                    # so is better than implying a check that did not happen.
                    print(f"⚠️  PREFLIGHT: connected as {label}, but audit_trail is empty, so")
                    print("   DELETE authority could not be exercised.")
                    return True
                cur.execute("DELETE FROM public.audit_trail WHERE id = %s", (row[0],))
                # Never committed. The row is untouched; only the trigger's verdict was wanted.
                conn.rollback()
    except Exception as exc:
        print(f"❌ PREFLIGHT: connected as {label}, but it cannot DELETE from audit_trail.")
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
    """Delete this run's rows, and any an interrupted run left in the Directory. Returns what failed.

    The Directory rows are the ones SEEDED names plus any still carrying a VALIDATE name; the
    historian rows are those of exactly the devices among them. Each step runs whether or not the
    one before it failed, so one failure leaves only its own rows behind.
    """
    print("Cleaning up validation data...")
    failures = []
    rows = {table: set() for table in CLEANUP_ORDER}
    for key, table in SEEDED_TABLES.items():
        if SEEDED.get(key + "_uuid"):
            rows[table].add(SEEDED[key + "_uuid"])
    unknown = [k for k in SEEDED if k.endswith("_uuid") and k[: -len("_uuid")] not in SEEDED_TABLES]
    if unknown:
        failures.append(f"SEEDED names {unknown} with no table in SEEDED_TABLES, so they were not deleted")
    asset_ids = {v for k, v in SEEDED.items()
                 if k.endswith("_id") and SEEDED_TABLES.get(k[: -len("_id")]) == "devices" and v}

    if not supabase_client:
        failures.append("no Supabase client, so no Directory row was deleted")
    else:
        # Rows an interrupted run left, found by name: cells.name, areas.name and schemas.schema_name
        # are UNIQUE, so one left behind fails the next seed.
        for table, column, pattern in (
            ("devices", "name", "VALIDATE_%"),
            ("gateways", "name", "VALIDATE_%"),
            ("cells", "name", VAL_CELL_NAME),
            ("areas", "name", VAL_AREA_NAME),
            ("schemas", "schema_name", "VALIDATE_%"),
        ):
            try:
                select = "id,sparkplug_id" if table == "devices" else "id"
                query = supabase_client.table(table).select(select)
                query = query.like(column, pattern) if "%" in pattern else query.eq(column, pattern)
                for row in query.execute().data or []:
                    rows[table].add(row["id"])
                    if row.get("sparkplug_id"):
                        asset_ids.add(row["sparkplug_id"])
            except Exception as e:
                failures.append(f"finding leftover {table}: {e}")

        # A device's own sparkplug_id too, for a row SEEDED holds by id alone.
        if rows["devices"]:
            try:
                found = supabase_client.table("devices").select("sparkplug_id").in_(
                    "id", sorted(rows["devices"])).execute()
                asset_ids.update(r["sparkplug_id"] for r in found.data or [] if r.get("sparkplug_id"))
            except Exception as e:
                failures.append(f"reading the devices' sparkplug_ids: {e}")

        for table in CLEANUP_ORDER:
            if rows[table]:
                try:
                    supabase_client.table(table).delete().in_("id", sorted(rows[table])).execute()
                except Exception as e:
                    failures.append(f"deleting {len(rows[table])} row(s) from {table}: {e}")

        # Birth parameters are keyed by sparkplug_id with no foreign key, so nothing cascades them.
        if asset_ids:
            try:
                supabase_client.table("asset_config").delete().in_("asset_id", sorted(asset_ids)).execute()
            except Exception as e:
                failures.append(f"deleting asset_config rows: {e}")

    # Audit rows last, since each DELETE above writes one. Through the owner connection because the
    # append-only trigger refuses service_role; guarded because an empty list must not become an
    # unfiltered DELETE of the whole audit history.
    entity_ids = sorted(set().union(*rows.values()))
    if entity_ids:
        try:
            audit_conn = get_supabase_admin_connection()
            try:
                audit_conn.autocommit = True
                with audit_conn.cursor() as cur:
                    cur.execute("DELETE FROM public.audit_trail WHERE entity_id = ANY(%s::uuid[])",
                                (entity_ids,))
            finally:
                audit_conn.close()
        except Exception as e:
            failures.append(f"{len(entity_ids)} entity id(s) left in public.audit_trail, which only "
                            f"an owner connection can clear: {e}")

    failures += cleanup_historian(asset_ids)
    return failures


def cleanup_historian(asset_ids):
    """Delete the historian rows of exactly these devices. Returns what failed.

    One asset per statement, each its own transaction, the id a literal: TimescaleDB decompresses
    only the compressed batches whose `asset_id` segment matches a constant, and caps what one
    transaction may decompress. A subquery matches no segment, so it decompresses every batch in the
    hypertable. See docs/testing.md, "What validate.py leaves behind".
    """
    if not asset_ids:
        return []
    failures = []
    try:
        conn = get_timescaledb_connection()
    except Exception as e:
        return [f"historian: no connection, so {len(asset_ids)} asset(s) keep their rows: {e}"]
    try:
        conn.autocommit = True
        with conn.cursor() as cur:
            for asset_id in sorted(asset_ids):
                try:
                    cur.execute("DELETE FROM telemetry WHERE asset_id = %s", (asset_id,))
                except Exception as e:
                    failures.append(f"telemetry of {asset_id}: {e}")
            # Run whatever happened above. The foreign key keeps an asset whose telemetry remains,
            # and the query after it names each one kept.
            ids = sorted(asset_ids)
            try:
                cur.execute(
                    "DELETE FROM assets a WHERE a.asset_id = ANY(%s) "
                    "AND NOT EXISTS (SELECT 1 FROM telemetry t WHERE t.asset_id = a.asset_id)",
                    (ids,),
                )
            except Exception as e:
                failures.append(f"assets: {e}")
            cur.execute("SELECT asset_id FROM assets WHERE asset_id = ANY(%s)", (ids,))
            kept = sorted(r[0] for r in cur.fetchall())
            if kept:
                failures.append(f"{len(kept)} historian asset(s) still hold rows: {', '.join(kept)}")
    except Exception as e:
        failures.append(f"historian: {e}")
    finally:
        conn.close()
    return failures


def report_cleanup(failures):
    """Check 16: the end-of-run cleanup, reported as an outcome. Returns True when it passed."""
    if not failures:
        print("✅ 16. CLEANUP: this run's Directory, audit, birth-parameter and historian rows are gone.")
        return True
    print(f"❌ 16. CLEANUP FAIL: {len(failures)} step(s) left rows behind, and the next run inherits them.")
    for failure in failures:
        print(f"      -> {failure}")
    return False

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


def make_typed_payload(asset_id, typed_metrics, timestamp_ms, declare):
    """A payload whose values travel in their Sparkplug datatype's field: {name: (datatype, value)}.
    `declare` writes each datatype, as a birth must. DATA leaves them out, as Sparkplug recommends,
    so a receiver has to take them from the birth; a signed integer is its two's complement.
    """
    payload = sparkplug_b_pb2.Payload()
    payload.timestamp = timestamp_ms

    m_asset = payload.metrics.add()
    m_asset.name = "Asset_ID"
    m_asset.string_value = asset_id
    m_asset.datatype = 12

    for name, (datatype, value) in typed_metrics.items():
        m = payload.metrics.add()
        m.name = name
        m.timestamp = timestamp_ms
        if declare:
            m.datatype = datatype
        if datatype in (1, 2, 3, 5, 6, 7):
            m.int_value = value & 0xFFFFFFFF
        elif datatype in (4, 8):
            m.long_value = value & 0xFFFFFFFFFFFFFFFF
        elif datatype == 10:
            m.double_value = value
        elif datatype == 11:
            m.boolean_value = value
        else:
            m.string_value = value

    return payload.SerializeToString()


def seed_supabase():
    print("Seeding Supabase test metadata (cells, gateways, registered devices)...")
    if not supabase_client:
        print("Skipping Supabase seed: client unavailable")
        return

    # The area, and the cell filed in it.
    a_res = supabase_client.table("areas").insert({"name": VAL_AREA_NAME}).execute()
    SEEDED["area_uuid"] = a_res.data[0]["id"] if a_res.data else None
    c_res = supabase_client.table("cells").insert(
        {"name": VAL_CELL_NAME, "area_id": SEEDED["area_uuid"]}
    ).execute()
    cell_id = c_res.data[0]["id"] if c_res.data else None
    # Kept on SEEDED so check 2 can scope itself to this run's entities: audit_trail is keyed
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

    # A gateway serving the whole area rather than one cell. It never publishes.
    ag_res = supabase_client.table("gateways").insert({
        "name": VAL_AREA_GW_NAME,
        "location_scope": "area_wide",
        "area_id": SEEDED["area_uuid"],
    }).execute()
    area_gateway = ag_res.data[0] if ag_res.data else {}
    SEEDED["area_gateway_uuid"] = area_gateway.get("id")
    SEEDED["area_gateway_id"] = area_gateway.get("sparkplug_id")

    # Seed the registered devices. sparkplug_id is a generated column, so it comes back on the
    # insert -- these are the ids the simulated gateways will publish under. Plant device B names
    # its cell itself; every other device inherits its gateway's.
    for label, key, placement in (
        (VAL_KNOWN_DEVICE, "known", {}),
        (VAL_LEGACY_DEVICE, "legacy", {}),
        (VAL_MISMATCH_DEVICE, "mismatch", {}),
        (VAL_ALIAS_DEVICE, "alias", {}),
        (VAL_PLANT_A_DEVICE, "plant_a", {}),
        (VAL_PLANT_B_DEVICE, "plant_b", {"cell_id": cell_id}),
        (VAL_WITHDRAWN_DEVICE, "withdrawn", {}),
    ):
        # NO `status`: the column defaults to OFFLINE, which is what a device the broker has never
        # heard from is. Seeding ONLINE was both untrue -- nothing had published yet -- and a weaker
        # fixture, because check 10 could then not tell a device the watchdog had correctly timed
        # out from one whose birth had never registered at all. 0119 refuses the seeded row outright.
        res = supabase_client.table("devices").insert({
            "name": label,
            "gateway_id": SEEDED["gateway_uuid"],
            "is_quarantined": False,
            **placement,
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

    # Plant device A's one schema, attached both ways as the known device's first is, so A has
    # exactly one type whichever of the two a reader resolves. Its semantic id is what check 12j
    # expects as the device's sourceTypeId.
    p_res = supabase_client.table("schemas").insert({
        "schema_name": VAL_PLANT_SCHEMA_NAME,
        "description": "End-to-end validation plant device",
        "status": "draft",
        "semantic_id": VAL_PLANT_SCHEMA_SEMANTIC_ID,
        "semantic_id_type": "IRI",
        "schema_definition": {
            "type": "object",
            "properties": {
                name: {"type": "number" if datatype == 10 else "string"}
                for name, (datatype, _birth, _data) in VAL_PLANT_METRICS["plant_a"].items()
            },
            "required": sorted(VAL_PLANT_METRICS["plant_a"]),
        },
    }).execute()
    SEEDED["plant_schema_uuid"] = p_res.data[0]["id"] if p_res.data else None
    if SEEDED.get("plant_schema_uuid") and SEEDED.get("plant_a_uuid"):
        supabase_client.table("devices").update(
            {"schema_id": SEEDED["plant_schema_uuid"]}
        ).eq("id", SEEDED["plant_a_uuid"]).execute()
        supabase_client.table("device_submodels").insert({
            "device_id": SEEDED["plant_a_uuid"],
            "schema_id": SEEDED["plant_schema_uuid"],
        }).execute()

    missing = [k for k, v in SEEDED.items() if not v]
    if missing:
        print(f"⚠️  Seed incomplete, missing: {missing}")

    print("Supabase test metadata seeded successfully.")
    print(f"  Gateway  {VAL_GW_NAME}     -> {SEEDED.get('gateway_id')}")
    print(f"  Device   {VAL_KNOWN_DEVICE} -> {SEEDED.get('known_id')}")

def connect_publisher(capture=True):
    """
    A connected broker session as the seeded gateway, its network loop running, or None when the
    broker cannot be reached. `capture` subscribes to the NCMD and STATE topics checks 9 and 15 read.
    """
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

    def on_state(_client, _userdata, msg):
        CAPTURED_STATE.append((msg.topic, msg.payload, msg.retain))

    if capture:
        client.message_callback_add("spBv1.0/+/NCMD/+", on_ncmd)
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
        if rc == 0 and capture:
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
        return None

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
    return client


def run_simulation():
    client = connect_publisher()
    if client is None:
        return

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

    # 3. DBIRTH then DDATA for the registered device -> ingested, keyed by its sparkplug_id. Born
    #    first: DDATA from an OFFLINE device not born draws a rebirth request, and that would spend
    #    the node's rate limit before check 9 asks for one. The birth declares a smaller set than
    #    step 7's, so step 7's first birth is still a change.
    print(f"\n--- DBIRTH then DDATA from registered device: {VAL_KNOWN_DEVICE} ({SEEDED.get('known_id')}) ---")
    known_reading = {"Systems/TEMPERATURE": 42.5, "Controller/EXECUTION": "ACTIVE", "Controller/EMERGENCY_STOP": "ARMED"}
    publish("DBIRTH", SEEDED["known_id"], known_reading)
    publish("DDATA", SEEDED["known_id"], known_reading)

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
    # the second, since log_audit_trail_event() fires on every UPDATE to `devices`.
    print(f"\n--- DBIRTH from registered device declaring an unmodelled metric: {VAL_UNMODELLED_METRIC} ---")
    publish("DBIRTH", SEEDED["known_id"], VAL_KNOWN_BIRTH)

    if supabase_client and SEEDED.get("known_uuid"):
        res = supabase_client.table("devices").select("last_birth_metrics_at").eq(
            "id", SEEDED["known_uuid"]
        ).execute()
        SEEDED["birth_metrics_at"] = res.data[0]["last_birth_metrics_at"] if res.data else None

    print("\n--- Identical DBIRTH again: the declared set is unchanged, so nothing must be written ---")
    time.sleep(6)  # outlast the daemon's 5s device-resolution cache
    publish("DBIRTH", SEEDED["known_id"], VAL_KNOWN_BIRTH)

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

        print("\n--- A second undeclared alias immediately after -> expect NO further NCMD ---")
        client.publish(
            f"spBv1.0/{VAL_GROUP}/DDATA/{gw}/{alias_dev}",
            make_alias_only_payload({ALIAS_UNDECLARED_SECOND: 2.0}, now_ms + 3000),
        )
        time.sleep(3)
        SEEDED["ncmd_after_second"] = len(CAPTURED_NCMD)

    # 11. The plant check 12 reads: each device births, then publishes, stamped with the wall clock
    # rather than `now_ms` so no row collides with an earlier one on the historian's key. The DATA
    # declares no datatypes, so reading the Int32 back negative takes the birth's declaration. Each
    # DATA is recorded as `<key>_samples`, (ms, {name: value}), which the history checks read.
    for key, metrics in VAL_PLANT_METRICS.items():
        device_id = SEEDED.get(key + "_id")
        if not device_id:
            continue
        print(f"\n--- DBIRTH then DDATA from plant device {key} ({device_id}) ---")
        born_ms = int(time.time() * 1000)
        birth = {name: (datatype, first) for name, (datatype, first, _then) in metrics.items()}
        client.publish(f"spBv1.0/{VAL_GROUP}/DBIRTH/{gw}/{device_id}",
                       make_typed_payload(device_id, birth, born_ms, declare=True))
        time.sleep(2)
        messages = [{name: then for name, (_datatype, _first, then) in metrics.items()}]
        messages += list(VAL_PLANT_LATER.get(key, ()))
        for offset, message in enumerate(messages, start=1):
            at_ms = born_ms + 1000 * offset
            typed = {name: (metrics[name][0], value) for name, value in message.items()}
            client.publish(f"spBv1.0/{VAL_GROUP}/DDATA/{gw}/{device_id}",
                           make_typed_payload(device_id, typed, at_ms, declare=False))
            SEEDED.setdefault(key + "_samples", []).append((at_ms, dict(message)))
            time.sleep(1)
        time.sleep(1)

    client.loop_stop()
    client.disconnect()
    record_ingested_devices()


def freshen_the_plant():
    """
    Just before checks 12 and 17: a node heartbeat from the seeded gateway, and step 7's birth
    again from the registered device. i3X holds a device's values Uncertain once its gateway has
    not beaten for 90 s or the device is OFFLINE, and the simulation's last node message is minutes
    old by then. A DBIRTH sets a device ONLINE whatever took it OFFLINE; this one declares the same
    set, so it rewrites nothing else.
    """
    client = connect_publisher(capture=False)
    if client is None:
        return
    gw = SEEDED.get("gateway_id") or VAL_GW_NAME
    at_ms = int(time.time() * 1000)
    print(f"\n--- Before the i3X checks: NDATA from {gw}, and DBIRTH from {SEEDED.get('known_id')} ---")
    # A node payload with no metrics: a plain heartbeat.
    client.publish(f"spBv1.0/{VAL_GROUP}/NDATA/{gw}", make_node_birth_payload({}, at_ms))
    if SEEDED.get("known_id"):
        client.publish(f"spBv1.0/{VAL_GROUP}/DBIRTH/{gw}/{SEEDED['known_id']}",
                       make_sparkplug_payload(SEEDED["known_id"], VAL_KNOWN_BIRTH, at_ms))
    time.sleep(2)
    client.loop_stop()
    client.disconnect()


def record_ingested_devices():
    """Put the rows ingestion created from this run's traffic in SEEDED, so the checks and the cleanup
    name them by id: the unregistered device it quarantined, and the malformed one."""
    if not supabase_client:
        return
    for key, wire_id in (("quarantined", UNKNOWN_DEVICE_ID), ("malformed", MALFORMED_DEVICE_ID)):
        res = supabase_client.table("devices").select("id,sparkplug_id").eq(
            "reported_identity", wire_id
        ).order("created_at", desc=True).limit(1).execute()
        row = res.data[0] if res.data else {}
        SEEDED[key + "_uuid"] = row.get("id")
        SEEDED[key + "_id"] = row.get("sparkplug_id")


def sign_in_admin():
    """An access token for the seeded administrator (supabase/seed.sql), or None and the reason."""
    try:
        req = urllib.request.Request(
            f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
            data=json.dumps({"email": "admin@aber.local", "password": "aber123"}).encode(),
            headers={"apikey": SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())["access_token"], None
    except Exception as err:
        return None, err


# =================================================================================================
# Check 12: the i3X server, against the Directory
# =================================================================================================
# Not a conformance check: CESMII's suite covers the protocol and CI runs it. These assert what the
# suite cannot know about this deployment: that the address space says what the Directory holds for
# the plant this run seeded, and the server's own rules. Each assertion is a function taking an
# I3xContext and returning (True | False | None for skipped, detail), listed in I3X_CHECKS.

I3X_BASE_URL = os.getenv("I3X_BASE_URL", "http://localhost:8090").rstrip("/")
# Every route i3x_service.ROUTES serves. check-docs-drift check 35 holds the two equal, so check 12h
# cannot miss one.
I3X_ROUTES = (
    "GET /info",
    "GET /namespaces",
    "GET /objecttypes",
    "POST /objecttypes/query",
    "GET /relationshiptypes",
    "POST /relationshiptypes/query",
    "GET /objects",
    "POST /objects/list",
    "POST /objects/related",
    "POST /objects/value",
    "POST /objects/history",
    "PUT /objects/value",
    "PUT /objects/history",
    "POST /subscriptions",
    "POST /subscriptions/list",
    "POST /subscriptions/delete",
    "POST /subscriptions/register",
    "POST /subscriptions/unregister",
    "POST /subscriptions/sync",
    "POST /subscriptions/stream",
)
I3X_UNAUTHENTICATED_ROUTES = ("GET /info",)
I3X_SITE = "i3x:site"
RFC3339_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def i3x_request(method, path, token=None, body=None, authorization=None):
    """One request to the i3X server: (HTTP status, parsed JSON or None), status 0 if unreachable.
    `authorization` sends that header verbatim in place of the token's. Raw urllib, like check 11's
    probe: the Supabase client would attach credentials that 12b and 12h need absent or wrong."""
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if authorization is not None:
        headers["Authorization"] = authorization
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{I3X_BASE_URL}/v1{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as err:
        status, raw = err.code, err.read()
    except Exception as err:
        return 0, {"error": str(err)}
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, None


def i3x_bulk(path, token, body):
    """A bulk POST's results by elementId: each item's `result`, or None where it failed."""
    status, answer = i3x_request("POST", path, token, body)
    results = answer.get("results") if status == 200 and isinstance(answer, dict) else None
    return {r.get("elementId"): (r.get("result") if r.get("success") else None) for r in results or []}


def i3x_value(token, element_id):
    """The current value of one object: {value, quality, timestamp, ...}, or None."""
    return i3x_bulk("/objects/value", token, {"elementIds": [element_id]}).get(element_id)


class I3xContext:
    """What check 12's assertions share, read once: the caller's token, /info's result, every object
    with its metadata, and the Directory's resolved location for each device this run seeded."""

    def __init__(self, token, info):
        self.token = token
        self.info = info
        self.objects_status, answer = i3x_request("GET", "/objects?includeMetadata=true", token)
        result = answer.get("result") if isinstance(answer, dict) else None
        self.objects = {o.get("elementId"): o for o in result or [] if isinstance(o, dict)}
        uuids = [SEEDED[key + "_uuid"] for key in seeded_keys("devices")]
        rows = []
        if uuids and supabase_client:
            rows = supabase_client.table("device_locations").select(
                "device_id,effective_cell_id,effective_area_id"
            ).in_("device_id", uuids).execute().data or []
        self.locations = {row["device_id"]: row for row in rows}
        self._types = None

    def object(self, element_id):
        return self.objects.get(element_id)

    def types(self):
        """GET /objecttypes by elementId, read once."""
        if self._types is None:
            status, answer = i3x_request("GET", "/objecttypes", self.token)
            result = answer.get("result") if status == 200 and isinstance(answer, dict) else None
            self._types = {t.get("elementId"): t for t in result or [] if isinstance(t, dict)}
        return self._types

    def effective_cell(self, key):
        """The cell device_locations resolves for the device SEEDED names by `key`."""
        return (self.locations.get(SEEDED.get(key + "_uuid")) or {}).get("effective_cell_id")


def check_i3x_read_only(ctx):
    # Update is declared false AND unimplemented: a client trusting the flag and one probing the verb
    # must agree.
    caps = (ctx.info.get("capabilities") or {}).get("update") or {}
    status, _ = i3x_request("PUT", "/objects/value", ctx.token, {})
    if caps.get("current") is False and status == 405:
        return True, "update.current is false and PUT /objects/value answers 405 -- the flag and the verb agree"
    return False, (f"capabilities.update.current={caps.get('current')}, PUT /objects/value returned "
                   f"{status}. Expected false and 405.")


def check_i3x_fail_closed(ctx):
    status, _ = i3x_request("GET", "/objects")
    if status == 401:
        return True, "an unauthenticated /objects read answers 401"
    return False, f"unauthenticated /objects returned {status}, expected 401."


def check_i3x_address_space(ctx):
    # The seeded device names no cell of its own, so its parent is its gateway's cell.
    known, cell = SEEDED.get("known_id"), SEEDED.get("cell_uuid")
    device = ctx.object(known)
    if device and device.get("parentId") == cell:
        return True, f"{known} is present, parented to its gateway's cell {cell}"
    if device:
        gateways = {eid for eid, o in ctx.objects.items() if o.get("typeElementId") == "i3x:type:gateway"}
        wrong = ("its gateway: HasParent is organizational hierarchy, and the data path belongs on "
                 "ConnectsVia" if device.get("parentId") in gateways else "not the resolved cell")
        return False, f"the device's parentId is {device.get('parentId')}, {wrong}. Expected {cell}."
    return False, f"{known} is not in /objects ({len(ctx.objects)} objects, HTTP {ctx.objects_status})."


def check_i3x_single_root(ctx):
    # `parentId: null` means root in i3X, which is why Unassigned hangs off the site.
    roots = sorted(eid for eid, o in ctx.objects.items() if o.get("parentId") is None)
    if roots == [I3X_SITE]:
        return True, f"exactly one object has a null parentId ({I3X_SITE})"
    return False, f"roots are {roots}, expected ['{I3X_SITE}']."


def check_i3x_live_values(ctx):
    # Values come from MQTT, not the database: a metric this run published is served.
    value = i3x_value(ctx.token, SEEDED.get("known_id")) or {}
    metrics = value.get("value") if isinstance(value.get("value"), dict) else {}
    if metrics:
        return True, (f"{len(metrics)} metric(s) served from the MQTT cache (quality "
                      f"{value.get('quality')}), e.g. {sorted(metrics)[:3]}")
    return False, f"no current value for {SEEDED.get('known_id')}: {value}"


def check_i3x_values_rls_scoped(ctx):
    # The value cache has no policy of its own, so a caller the data layer refuses must get nothing.
    known = SEEDED.get("known_id")
    status, answer = i3x_request("POST", "/objects/value", body={"elementIds": [known]},
                                 authorization="Bearer not.a.valid.token")
    leaked = status == 200 and known in json.dumps(answer) and '"value":' in json.dumps(answer)
    if status in (401, 403) or (status == 200 and not leaked):
        return True, f"a caller whose token the data layer rejects gets no values (HTTP {status})"
    return False, (f"HTTP {status} returned live values to an unauthorised caller. The MQTT cache has "
                   "no RLS of its own -- every value read must be gated on a PostgREST resolve made "
                   "AS THE CALLER.")


def check_i3x_parent_is_resolved_cell(ctx):
    # Devices with no resolved cell are left out: where they sit follows the areas in the tree.
    compared, unresolved, wrong = 0, [], []
    for key in seeded_keys("devices"):
        cell, element_id = ctx.effective_cell(key), SEEDED.get(key + "_id")
        if cell is None:
            unresolved.append(key)
            continue
        compared += 1
        obj = ctx.object(element_id)
        if obj is None:
            wrong.append(f"{key} ({element_id}) is not in /objects")
        elif obj.get("parentId") != cell:
            wrong.append(f"{key} ({element_id}) has parentId {obj.get('parentId')}, resolved cell {cell}")
    if wrong or not compared:
        return False, "; ".join(wrong) or "no seeded device resolves to a cell, so nothing was compared"
    left_out = f"; not compared, no resolved cell: {', '.join(unresolved)}" if unresolved else ""
    return True, f"{compared} seeded device(s), each parented to its device_locations.effective_cell_id{left_out}"


def check_i3x_refuses_a_non_token(ctx):
    refused, wrong = 0, []
    for route in I3X_ROUTES:
        method, path = route.split(" ", 1)
        status, _ = i3x_request(method, path, body=None if method == "GET" else {},
                                authorization="not-a-token")
        expected = 200 if route in I3X_UNAUTHENTICATED_ROUTES else 401
        if status != expected:
            wrong.append(f"{route} -> {status}, expected {expected}")
        elif expected == 401:
            refused += 1
    if wrong:
        return False, ("a header that is not a token got past authentication, where anything but 401 "
                       "means it did. With `Authorization: not-a-token`: " + "; ".join(wrong))
    return True, (f"`Authorization: not-a-token` answers 401 on all {refused} authenticated routes, and "
                  f"{', '.join(I3X_UNAUTHENTICATED_ROUTES)} still answers")


def check_i3x_namespace_filter(ctx):
    compared, wrong = 0, []
    for path in ("/objecttypes", "/relationshiptypes"):
        status, answer = i3x_request("GET", path, ctx.token)
        every = answer.get("result") if status == 200 and isinstance(answer, dict) else None
        if not every:
            wrong.append(f"GET {path} -> HTTP {status} with no types to filter")
            continue
        uris = sorted({t.get("namespaceUri") for t in every if isinstance(t.get("namespaceUri"), str)})
        for uri in uris + ["urn:aber:validate:no-such-namespace"]:
            status, answer = i3x_request("GET", f"{path}?namespaceUri={urllib.parse.quote(uri, safe='')}",
                                         ctx.token)
            got = answer.get("result") if status == 200 and isinstance(answer, dict) else None
            want = sorted(t.get("elementId") for t in every if t.get("namespaceUri") == uri)
            compared += 1
            if got is None or sorted(t.get("elementId") for t in got) != want:
                wrong.append(f"{path}?namespaceUri={uri} -> HTTP {status}, "
                             f"{len(got) if got is not None else 'no'} type(s); expected {len(want)}")
    if wrong:
        return False, "; ".join(wrong)
    return True, (f"{compared} filtered reads of /objecttypes and /relationshiptypes each return exactly "
                  "the types in that namespace, and none for a namespace nothing uses")


def check_i3x_source_type(ctx):
    rows = supabase_client.table("schemas").select("semantic_id,schema_name").eq(
        "id", SEEDED.get("plant_schema_uuid")).execute().data if supabase_client else None
    if not rows:
        return False, f"the seeded schema {VAL_PLANT_SCHEMA_NAME} is not in the Directory"
    expected = rows[0].get("semantic_id") or rows[0].get("schema_name")
    got = ((ctx.object(SEEDED.get("plant_a_id")) or {}).get("metadata") or {}).get("sourceTypeId")
    if got == expected:
        return True, f"{VAL_PLANT_A_DEVICE}'s sourceTypeId is its schema's semantic id, {expected}"
    return False, (f"{VAL_PLANT_A_DEVICE}'s metadata.sourceTypeId is {got!r}; expected its schema's "
                   f"{expected!r} (the semantic_id, else the schema_name).")


def check_i3x_container_values(ctx):
    # A container's value counts devices, never its children: the cell's children include a gateway.
    cell = SEEDED.get("cell_uuid")
    values = i3x_bulk("/objects/value", ctx.token, {"elementIds": [I3X_SITE, cell]})
    site = (values.get(I3X_SITE) or {}).get("value") or {}
    in_cell = (values.get(cell) or {}).get("value") or {}
    # `is_archived=eq.false`, the filter i3X reads with, so a NULL counts on neither side.
    live = supabase_client.table("devices").select("id", count="exact").eq(
        "is_archived", "false").limit(1).execute().count
    cells = supabase_client.table("cells").select("id", count="exact").eq(
        "is_archived", "false").limit(1).execute().count
    located = [r["device_id"] for r in supabase_client.table("device_locations").select(
        "device_id").eq("effective_cell_id", cell).execute().data or []]
    live_in_cell = len(supabase_client.table("devices").select("id").in_("id", located).eq(
        "is_archived", "false").execute().data or []) if located else 0
    expected = {"site deviceCount": live, "site cellCount": cells, "cell deviceCount": live_in_cell}
    got = {"site deviceCount": site.get("deviceCount"), "site cellCount": site.get("cellCount"),
           "cell deviceCount": in_cell.get("deviceCount")}
    if got == expected:
        return True, (f"the site counts {live} device(s) in {cells} cell(s), and the seeded cell its "
                      f"{live_in_cell} device(s) without its gateway, as the Directory does")
    return False, f"i3X reports {got}; the Directory holds {expected}."


def check_i3x_invalid_input(ctx):
    known = SEEDED.get("known_id")
    # A window that is valid in every other respect, so each 400 can only be the field under test.
    end = int(time.time())
    window = {"startTime": datetime.fromtimestamp(end - 3600, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
              "endTime": datetime.fromtimestamp(end, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    probes = (
        ("/objects/value", {"maxDepth": "deep"}),
        ("/objects/value", {"maxDepth": -1}),
        ("/objects/history", {**window, "limit": "many"}),
        ("/objects/history", {**window, "limit": 0}),
    )
    wrong = []
    for path, fields in probes:
        status, _ = i3x_request("POST", path, ctx.token, {"elementIds": [known], **fields})
        if status != 400:
            shown = {k: v for k, v in fields.items() if k in ("maxDepth", "limit")}
            wrong.append(f"{path} {json.dumps(shown)} -> {status}")
    if wrong:
        return False, "expected 400 for each: " + "; ".join(wrong)
    return True, f"a non-integer or out-of-range maxDepth or limit answers 400, all {len(probes)} probes"


def expected_platform_version():
    """The chart's appVersion, and where it was read: ABER_PLATFORM_VERSION where the chart sets it,
    else this checkout's Chart.yaml, which is what the dev loop installs."""
    version = os.getenv("ABER_PLATFORM_VERSION", "").strip()
    if version:
        return version, "ABER_PLATFORM_VERSION"
    chart = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "deploy", "helm", "aber", "Chart.yaml")
    try:
        with open(chart, encoding="utf-8") as f:
            match = re.search(r'^appVersion:\s*"?([^"\s]+)"?\s*$', f.read(), re.M)
    except OSError:
        return None, None
    return (match.group(1), "deploy/helm/aber/Chart.yaml") if match else (None, None)


def check_i3x_server_version(ctx):
    expected, source = expected_platform_version()
    got = ctx.info.get("serverVersion")
    if expected is None:
        return None, "no ABER_PLATFORM_VERSION and no Chart.yaml beside this script to compare with"
    if got == expected:
        return True, f"serverVersion {got} is the chart's appVersion ({source})"
    return False, (f"serverVersion is {got!r} and the chart's appVersion {expected!r} ({source}). The "
                   "chart passes it as I3X_SERVER_VERSION; `dev` is a process started without it.")


def check_i3x_heartbeat_in_utc(ctx):
    gateway = SEEDED.get("gateway_id")
    value = (i3x_value(ctx.token, gateway) or {}).get("value") or {}
    beat = value.get("lastHeartbeat")
    if isinstance(beat, str) and RFC3339_UTC.match(beat):
        return True, f"{gateway}'s value carries lastHeartbeat {beat}"
    if beat is None:
        return False, f"{gateway}'s value has no lastHeartbeat, though this run's NBIRTH records one"
    return False, f"lastHeartbeat is {beat!r}; every i3X timestamp is RFC 3339 in UTC, ending in Z."


def check_i3x_signed_integers(ctx):
    device = SEEDED.get("plant_b_id")
    value = (i3x_value(ctx.token, device) or {}).get("value")
    served = value.get(VAL_SIGNED_METRIC) if isinstance(value, dict) else None
    stored = None
    conn = get_timescaledb_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT val_double FROM telemetry WHERE asset_id = %s AND metric_name = %s "
                        "ORDER BY time DESC LIMIT 1", (device, VAL_SIGNED_METRIC))
            row = cur.fetchone()
            stored = row[0] if row else None
    finally:
        conn.close()
    if served == VAL_SIGNED_DATA_VALUE and stored == VAL_SIGNED_DATA_VALUE:
        return True, (f"an Int32 published as {VAL_SIGNED_DATA_VALUE}, its datatype declared only at "
                      f"birth, reads back {served} through /objects/value and the historian holds {stored:g}")
    return False, (f"published {VAL_SIGNED_DATA_VALUE} as an Int32 declared at birth: i3X serves "
                   f"{served!r} and the historian holds {stored!r}. "
                   f"{VAL_SIGNED_DATA_VALUE & 0xFFFFFFFF} is its 32-bit pattern, unsigned.")


MTCONNECT_NAMESPACE = "https://aber.local/semantics/mtconnect/v2.0"
ISO22400_NAMESPACE = "https://aber.local/semantics/iso22400"
SCHEMA_SET_TYPE_PREFIX = "i3x:type:schemas:"
LOCATION_TYPES = ("i3x:type:site", "i3x:type:area", "i3x:type:cell", "i3x:type:lane",
                  "i3x:type:unassigned")


def relationships(obj):
    return ((obj or {}).get("metadata") or {}).get("relationships") or {}


def attached_schema_ids(key):
    """The schemas the Directory attaches to a seeded device, through the device_schemas view."""
    rows = supabase_client.table("device_schemas").select("schema_id").eq(
        "device_id", SEEDED.get(key + "_uuid")).execute().data or []
    return sorted({row["schema_id"] for row in rows if row.get("schema_id")})


def expected_components(key):
    """A seeded device's component metric names, as the Directory implies them: every metric its
    schemas model and every one its last DBIRTH declared. Returns (names, modelled, declared)."""
    uuid = SEEDED.get(key + "_uuid")
    modelled = modelled_metrics_across(device_schema_definitions(uuid)) or set()
    rows = supabase_client.table("devices").select("last_birth_metrics").eq("id", uuid).execute().data
    declared = set((rows[0].get("last_birth_metrics") if rows else None) or []) - IDENTITY_METRICS
    return sorted((modelled | declared) - IDENTITY_METRICS), modelled, declared


def live_count(table, ids=None, **equal):
    """How many rows of `table` are not archived, among `ids` if given, matching `equal`."""
    query = supabase_client.table(table).select("id", count="exact").eq("is_archived", "false")
    if ids is not None:
        if not ids:
            return 0
        query = query.in_("id", list(ids))
    for column, value in equal.items():
        query = query.eq(column, value)
    return query.limit(1).execute().count


def iso_ms(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z")


def epoch_ms(text):
    """An RFC 3339 timestamp as epoch milliseconds, or None."""
    try:
        return round(datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def is_scalar(value):
    return not isinstance(value, (dict, list))


def plant_history():
    """Plant device A's recorded DATA: (sparkplug_id, [(ms, {name: value})] oldest first, its two
    metric names, and a window one second wider than the samples on each side)."""
    samples = sorted(SEEDED.get("plant_a_samples") or [])
    if not samples:
        raise RuntimeError("plant device A published no DATA this run")
    first, second = list(VAL_PLANT_METRICS["plant_a"])
    window = {"startTime": iso_ms(samples[0][0] - 1000), "endTime": iso_ms(samples[-1][0] + 1000)}
    return SEEDED.get("plant_a_id"), samples, first, second, window


def check_i3x_device_typed_by_every_schema(ctx):
    known = SEEDED.get("known_id")
    obj = ctx.object(known) or {}
    meta = obj.get("metadata") or {}
    names, modelled, declared = expected_components("known")
    ids = attached_schema_ids("known")
    type_id = SCHEMA_SET_TYPE_PREFIX + "+".join(ids)
    wrong = []
    if len(ids) < 2:
        wrong.append(f"the Directory attaches {len(ids)} schema(s) to it, so it has no set to be typed by")
    if declared - modelled or obj.get("isExtended") is not False:
        wrong.append(f"isExtended is {obj.get('isExtended')!r}, and across its schemas the Directory "
                     f"leaves {sorted(declared - modelled)} of its declared metrics unmodelled")
    if obj.get("isComposition") is not True:
        wrong.append(f"isComposition is {obj.get('isComposition')!r}, expected true")
    if obj.get("typeElementId") != type_id or meta.get("sourceTypeId") != type_id:
        wrong.append(f"typeElementId {obj.get('typeElementId')!r} and sourceTypeId "
                     f"{meta.get('sourceTypeId')!r}, expected {type_id}")
    components = relationships(obj).get("HasComponent")
    if components != [f"{known}/{name}" for name in names]:
        wrong.append(f"HasComponent is {components}; expected {names} under {known}")
    if meta.get("system") != {"quarantined": False} or "quarantined" in meta or "schemaExtensions" in meta:
        wrong.append("metadata carries system " + json.dumps(meta.get("system")) + ", expected "
                     "{\"quarantined\": false} with no top-level quarantined or schemaExtensions")
    if wrong:
        return False, "; ".join(wrong)
    return True, (f"{known} is typed by its {len(ids)} schemas ({type_id}), not extended, and composed "
                  f"of the {len(names)} metrics they model or its birth declared")


def check_i3x_metrics_are_components(ctx):
    known = SEEDED.get("known_id")
    names, _, _ = expected_components("known")
    rows = supabase_client.table("metric_catalog").select("name,semantic_id").in_("name", names).execute()
    catalog = {row["name"]: row for row in rows.data or []}
    types = ctx.types()
    wrong = []
    for name in names:
        obj = ctx.object(f"{known}/{name}")
        if obj is None:
            wrong.append(f"{known}/{name} is not in /objects")
            continue
        meta = obj.get("metadata") or {}
        if (obj.get("parentId") != known or obj.get("isComposition") is not False
                or meta.get("relationships") != {"ComponentOf": [known]}):
            wrong.append(f"{name} has parentId {obj.get('parentId')}, isComposition "
                         f"{obj.get('isComposition')} and relationships {meta.get('relationships')}")
        type_id, row = obj.get("typeElementId") or "", catalog.get(name)
        if row:
            want = ("i3x:type:metric:" + name, row.get("semantic_id") or name,
                    (types.get("i3x:type:metric:" + name) or {}).get("namespaceUri"))
            got = (type_id, meta.get("sourceTypeId"), meta.get("typeNamespaceUri"))
            if got != want:
                wrong.append(f"{name} is typed {got}; its catalog row makes it {want}")
        elif not type_id.startswith("i3x:type:sparkplug:") and type_id != "i3x:type:unknown":
            wrong.append(f"{name} has no catalog row, so its type is its DBIRTH datatype's or "
                         f"UnknownType; got {type_id}")
    for name, namespace in (("Systems/TEMPERATURE", MTCONNECT_NAMESPACE), (VAL_KPI_METRIC, ISO22400_NAMESPACE)):
        got = ((ctx.object(f"{known}/{name}") or {}).get("metadata") or {}).get("typeNamespaceUri")
        if got != namespace:
            wrong.append(f"{name}'s typeNamespaceUri is {got!r}, expected {namespace}")
    metric_ids = {eid for eid in ctx.objects if "/" in eid}
    holders = sorted(eid for eid, o in ctx.objects.items()
                     if metric_ids & set(relationships(o).get("HasChildren", [])))
    if holders:
        wrong.append(f"metric ids appear under HasChildren of {holders}")
    if wrong:
        return False, "; ".join(wrong)
    return True, (f"each of {known}'s {len(names)} metrics is a leaf with only ComponentOf, typed by "
                  f"its catalog row ({len(catalog)}) or its datatype, and none is anyone's child")


def check_i3x_types_and_namespaces(ctx):
    ids = attached_schema_ids("known")
    type_id = SCHEMA_SET_TYPE_PREFIX + "+".join(ids)
    types = ctx.types()
    wrong = []
    synthesized = types.get(type_id)
    if synthesized is None:
        wrong.append(f"/objecttypes serves no {type_id}")
    else:
        schema = synthesized.get("schema") or {}
        if schema.get("type") != "object" or len(schema.get("allOf") or []) != len(ids):
            wrong.append(f"{type_id} has schema.type {schema.get('type')!r} and "
                         f"{len(schema.get('allOf') or [])} allOf entries, expected object and {len(ids)}")
        want = {"relationshipType": "InheritsFrom", "types": ids}
        if synthesized.get("related") != want:
            wrong.append(f"{type_id} is related {synthesized.get('related')}, expected {want}")
    if (types.get("i3x:type:unknown") or {}).get("schema", None) != {}:
        wrong.append(f"i3x:type:unknown is {types.get('i3x:type:unknown')}, expected schema {{}}")
    status, answer = i3x_request("GET", "/namespaces", ctx.token)
    listed = {n.get("uri") for n in (answer.get("result") if status == 200 else None) or []}
    status, answer = i3x_request("GET", "/relationshiptypes", ctx.token)
    rel_types = (answer.get("result") if status == 200 else None) or []
    used = {t.get("namespaceUri") for t in types.values()} | {t.get("namespaceUri") for t in rel_types}
    if listed != used:
        wrong.append(f"/namespaces lists {sorted(listed - used)} that no type uses and omits "
                     f"{sorted(used - listed)}")
    if wrong:
        return False, "; ".join(wrong)
    return True, (f"{type_id} is allOf its {len(ids)} schemas and inherits from them, UnknownType's "
                  f"schema is {{}}, and /namespaces lists exactly the {len(used)} the types use")


def check_i3x_metric_values(ctx):
    known = SEEDED.get("known_id")
    names, _, _ = expected_components("known")
    temperature = f"{known}/Systems/TEMPERATURE"
    wrong = []
    whole = i3x_bulk("/objects/value", ctx.token, {"elementIds": [known], "maxDepth": 0}).get(known) or {}
    value, components = whole.get("value"), whole.get("components")
    if not isinstance(value, dict) or not isinstance(components, dict):
        wrong.append(f"maxDepth 0 on {known} gave value {type(value).__name__} and components "
                     f"{type(components).__name__}")
    else:
        if set(components) != {f"{known}/{name}" for name in names}:
            wrong.append(f"its components are {sorted(components)}, expected its {len(names)} metrics")
        if (components.get(temperature) or {}).get("value") != value.get("Systems/TEMPERATURE"):
            wrong.append(f"{temperature} is {(components.get(temperature) or {}).get('value')!r} as a "
                         f"component and {value.get('Systems/TEMPERATURE')!r} in the device's map")
        unzoned = sorted(eid for eid, c in components.items() if not str(c.get("timestamp")).endswith("Z"))
        if unzoned:
            wrong.append(f"component timestamps not in Z: {unzoned}")
    alone = i3x_value(ctx.token, temperature) or {}
    reading = alone.get("value")
    if (alone.get("isComposition") is not False or isinstance(reading, bool)
            or not isinstance(reading, (int, float)) or alone.get("quality") != "Good"):
        wrong.append(f"{temperature} alone answers isComposition {alone.get('isComposition')!r}, value "
                     f"{reading!r}, quality {alone.get('quality')!r}")
    kpi = f"{known}/{VAL_KPI_METRIC}"
    edges = i3x_bulk("/objects/related", ctx.token, {"elementIds": [kpi]}).get(kpi)
    shape = [(e.get("sourceRelationship"), (e.get("object") or {}).get("elementId")) for e in edges or []]
    if shape != [("ComponentOf", known)]:
        wrong.append(f"{kpi}'s edges are {shape}, expected one ComponentOf to {known}")
    if wrong:
        return False, "; ".join(wrong)
    return True, (f"maxDepth 0 returns {known}'s map with its {len(names)} metrics as components, one "
                  f"metric reads alone as a Good scalar, and its only edge is ComponentOf")


def check_i3x_location_tree(ctx):
    objects, site = ctx.objects, I3X_SITE
    area, cell, gateway = SEEDED.get("area_uuid"), SEEDED.get("cell_uuid"), SEEDED.get("area_gateway_id")
    wrong = []
    gw_rels = relationships(objects.get(gateway))
    if (objects.get(gateway) or {}).get("parentId") != area or gw_rels.get("HasParent") != [area] \
            or "ComponentOf" in gw_rels:
        wrong.append(f"the area-wide gateway {gateway} has parentId "
                     f"{(objects.get(gateway) or {}).get('parentId')} and relationships {gw_rels}")
    area_obj, area_rels = objects.get(area) or {}, relationships(objects.get(area))
    if (area_obj.get("typeElementId") != "i3x:type:area" or area_obj.get("parentId") != site
            or not {gateway, cell} <= set(area_rels.get("HasChildren", []))):
        wrong.append(f"the area {area} is typed {area_obj.get('typeElementId')} under "
                     f"{area_obj.get('parentId')} with children {area_rels.get('HasChildren')}")
    if (objects.get(cell) or {}).get("parentId") != area:
        wrong.append(f"the cell's parentId is {(objects.get(cell) or {}).get('parentId')}, not its area")
    if area not in relationships(objects.get(site)).get("HasChildren", []):
        wrong.append("the site does not list the area among its children")
    lanes = supabase_client.table("gateways").select("sparkplug_id,is_shadow,is_simulated").eq(
        "is_archived", "false").or_("is_shadow.eq.true,is_simulated.eq.true").execute().data or []
    for row in lanes:
        lane = "i3x:lane:shadow" if row.get("is_shadow") else "i3x:lane:simulated"
        lane_obj = objects.get(lane) or {}
        if (objects.get(row["sparkplug_id"]) or {}).get("parentId") != lane:
            wrong.append(f"gateway {row['sparkplug_id']} is not under {lane}")
        if (lane_obj.get("typeElementId"), lane_obj.get("parentId")) != ("i3x:type:lane", site) or \
                lane_obj.get("displayName") != ("Shadow" if row.get("is_shadow") else "Simulated"):
            wrong.append(f"{lane} is {lane_obj.get('typeElementId')} under {lane_obj.get('parentId')}, "
                         f"named {lane_obj.get('displayName')!r}")
    if (objects.get("i3x:unassigned") or {}).get("typeElementId") != "i3x:type:unassigned":
        wrong.append("i3x:unassigned is not typed i3x:type:unassigned")
    places = {eid for eid, o in objects.items() if o.get("typeElementId") in LOCATION_TYPES}
    composing = sorted(eid for eid in places
                       if objects[eid].get("isComposition") is not False or "HasComponent" in relationships(objects[eid]))
    if composing:
        wrong.append(f"locations that compose: {composing}")
    naming = sorted(eid for eid, o in objects.items() for rel in ("ComponentOf", "HasComponent")
                    if places & set(relationships(o).get(rel, [])))
    if naming:
        wrong.append(f"objects with a component edge to a location: {naming}")
    dangling = sorted(eid for eid, o in objects.items()
                      if o.get("parentId") is not None and o.get("parentId") not in objects)
    if dangling:
        wrong.append(f"parentIds that resolve to nothing: {dangling}")
    if wrong:
        return False, "; ".join(wrong)
    return True, (f"the area sits under the site with its cell and area-wide gateway, {len(lanes)} lane "
                  f"gateway(s) sit in their lanes, {len(places)} locations compose nothing, and every "
                  f"parentId resolves")


def check_i3x_site_name(ctx):
    status, answer = i3x_request("GET", "/objects?root=true", ctx.token)
    roots = (answer.get("result") if status == 200 else None) or []
    rows = supabase_client.table("system_settings").select("value").eq("key", "site.name").execute().data
    setting = rows[0].get("value") if rows else None
    expected = setting.strip() if isinstance(setting, str) and setting.strip() else "Site"
    got = [(r.get("elementId"), r.get("displayName")) for r in roots]
    if got == [(I3X_SITE, expected)]:
        return True, f"the one root is {I3X_SITE}, named {expected!r} as site.name has it"
    return False, f"roots are {got}; expected [({I3X_SITE!r}, {expected!r})] from site.name {setting!r}"


def check_i3x_location_values(ctx):
    area = SEEDED.get("area_uuid")
    values = i3x_bulk("/objects/value", ctx.token, {"elementIds": [area, I3X_SITE], "maxDepth": 0})
    area_value, site_value = values.get(area), values.get(I3X_SITE)
    located = supabase_client.table("device_locations").select("device_id").eq(
        "effective_area_id", area).execute().data or []
    expected = {"cellCount": live_count("cells", area_id=area),
                "deviceCount": live_count("devices", {r["device_id"] for r in located})}
    wrong = []
    if area_value is None:
        wrong.append(f"the area {area} has no value")
    else:
        value = area_value.get("value") or {}
        if (area_value.get("isComposition") is not False or area_value.get("quality") != "Good"
                or "components" in area_value or set(value) != {"cellCount", "deviceCount", "description"}):
            wrong.append(f"the area's value is {area_value}")
        elif {k: value[k] for k in expected} != expected:
            wrong.append(f"the area counts {value}; the Directory holds {expected}")
    if site_value is None or "components" in site_value:
        wrong.append(f"the site's value at maxDepth 0 is {site_value}")
    if wrong:
        return False, "; ".join(wrong)
    return True, (f"the area counts {expected['cellCount']} cell(s) and {expected['deviceCount']} "
                  f"device(s) as the Directory does, and neither it nor the site returns components")


def check_i3x_history_names_its_metrics(ctx):
    device, samples, first, second, window = plant_history()
    low, high = epoch_ms(window["startTime"]), epoch_ms(window["endTime"])
    wrong = []
    status, answer = i3x_request("POST", "/objects/history", ctx.token,
                                 {"elementIds": [f"{device}/{first}"], **window})
    result = ((answer or {}).get("results") or [{}])[0].get("result") or {}
    got = [v.get("value") for v in result.get("values") or []]
    want = [message[first] for _ms, message in reversed(samples) if first in message]
    if status != 200 or result.get("isComposition") is not False or got != want or not all(map(is_scalar, got)):
        wrong.append(f"{first} alone: HTTP {status}, isComposition {result.get('isComposition')!r}, "
                     f"values {got}, expected {want} newest first")
    status, answer = i3x_request("POST", "/objects/history", ctx.token, {"elementIds": [device], **window})
    maps = [v for v in ((((answer or {}).get("results") or [{}])[0].get("result") or {}).get("values") or [])]
    state = {}
    for _ms, message in samples:
        state.update(message)
    stamps = [epoch_ms(v.get("timestamp")) for v in maps]
    if (status != 200 or len(maps) != len(samples) or not all(isinstance(v.get("value"), dict) for v in maps)
            or (maps and {k: maps[0]["value"].get(k) for k in (first, second)} != {k: state[k] for k in (first, second)})
            or not all(s is not None and low <= s <= high for s in stamps)):
        wrong.append(f"the device: HTTP {status}, {len(maps)} value(s) for {len(samples)} published "
                     f"instants, newest {maps[0] if maps else None}, expected {state}")
    status, answer = i3x_request("POST", "/objects/history", ctx.token,
                                 {"elementIds": [device], "maxDepth": 0, **window})
    components = ((((answer or {}).get("results") or [{}])[0].get("result") or {}).get("components")) or {}
    names, _, _ = expected_components("plant_a")
    if set(components) != {f"{device}/{name}" for name in names} or not all(
            isinstance(c.get("values"), list) and all(is_scalar(v.get("value")) for v in c["values"])
            for c in components.values()):
        wrong.append(f"maxDepth 0: HTTP {status}, components {sorted(components)}, expected one series of "
                     f"scalars per metric of {names}")
    if wrong:
        return False, "; ".join(wrong)
    return True, (f"a metric's history is its own scalars, the device's is one map per instant naming "
                  f"its metrics, and maxDepth 0 adds each metric's series ({len(samples)} DATA published)")


def check_i3x_history_carries_forward(ctx):
    device, samples, first, second, window = plant_history()
    # The first DATA without `first`, and the value `first` held before it.
    for index, (ms, message) in enumerate(samples):
        before = [m[first] for _t, m in samples[:index] if first in m]
        if first not in message and before:
            break
    else:
        return None, f"no DATA in this run's fixture omits {first}"
    start = iso_ms((samples[index - 1][0] + ms) // 2)
    status, answer = i3x_request("POST", "/objects/history", ctx.token,
                                 {"elementIds": [device], "startTime": start, "endTime": window["endTime"]})
    maps = (((answer or {}).get("results") or [{}])[0].get("result") or {}).get("values") or []
    at = next((v.get("value") for v in maps if epoch_ms(v.get("timestamp")) == ms), None)
    if status == 200 and isinstance(at, dict) and at.get(first) == before[-1]:
        return True, (f"the map at {iso_ms(ms)}, where only {second} changed, carries {first} = "
                      f"{before[-1]} from before the window's start")
    return False, (f"history from {start}: HTTP {status}; the map at {iso_ms(ms)} is {at}, expected "
                   f"{first} = {before[-1]} carried forward")


def check_i3x_history_bounds(ctx):
    device, samples, first, _second, window = plant_history()
    series = [(ms, m[first]) for ms, m in reversed(samples) if first in m]
    wrong = []
    if len(series) < 2:
        return False, f"{first} has {len(series)} sample(s) in the fixture; a cut needs two"
    metric = f"{device}/{first}"
    status, answer = i3x_request("POST", "/objects/history", ctx.token,
                                 {"elementIds": [metric], "limit": 1, **window})
    answer = answer or {}
    item = (answer.get("results") or [{}])[0]
    values = (item.get("result") or {}).get("values") or []
    detail = (item.get("responseDetail") or {}).get("detail") or ""
    cut = re.search(r"nothing at or before (\S+) was returned", detail)
    if (status != 206 or (answer.get("responseDetail") or {}).get("status") != 206
            or (answer.get("responseDetail") or {}).get("title") != "Partial results returned"
            or item.get("success") is not True or (item.get("responseDetail") or {}).get("status") != 206
            or [v.get("value") for v in values] != [series[0][1]] or cut is None):
        wrong.append(f"limit 1: HTTP {status}, responseDetail {answer.get('responseDetail')}, item "
                     f"{item.get('success')} {item.get('responseDetail')}, values {values}")
    else:
        status, answer = i3x_request("POST", "/objects/history", ctx.token,
                                     {"elementIds": [metric], "limit": 1, "startTime": window["startTime"],
                                      "endTime": cut.group(1)})
        rest = (((answer or {}).get("results") or [{}])[0].get("result") or {}).get("values") or []
        if status != 200 or [v.get("value") for v in rest] != [series[1][1]]:
            wrong.append(f"again with endTime {cut.group(1)}: HTTP {status}, values {rest}, expected "
                         f"[{series[1][1]!r}]")
    for label, fields in (
        ("startTime after endTime", {"startTime": window["endTime"], "endTime": window["startTime"]}),
        ("a startTime that is not a timestamp", {"startTime": "2026-09-28T10:00:00Z),or(x",
                                                 "endTime": window["endTime"]}),
        ("a startTime with no offset", {"startTime": window["startTime"].rstrip("Z"),
                                        "endTime": window["endTime"]}),
    ):
        status, _ = i3x_request("POST", "/objects/history", ctx.token, {"elementIds": [metric], **fields})
        if status != 400:
            wrong.append(f"{label} answered {status}, expected 400")
    if wrong:
        return False, "; ".join(wrong)
    return True, ("a series cut by its limit is a 206 naming where to resume, resuming there returns "
                  "the next value, and three malformed windows are each a 400")


def check_i3x_subscription_follows_its_owner(ctx):
    # Runs last: it archives the device, and restores it whatever happens.
    device, uuid = SEEDED.get("withdrawn_id"), SEEDED.get("withdrawn_uuid")
    client = {"clientId": VAL_SUBSCRIPTION_CLIENT}
    status, answer = i3x_request("POST", "/subscriptions", ctx.token, client)
    sub = ((answer or {}).get("result") or {}).get("subscriptionId")
    if status != 200 or not sub:
        return False, f"POST /subscriptions answered {status}: {answer}"
    ids = {**client, "subscriptionId": sub}

    def register():
        status, answer = i3x_request("POST", "/subscriptions/register", ctx.token,
                                     {**ids, "elementIds": [device]})
        return status, ((answer or {}).get("results") or [{}])[0]

    wrong, archived = [], False
    try:
        status, item = register()
        sync_status, answer = i3x_request("POST", "/subscriptions/sync", ctx.token, ids)
        if status != 200 or item.get("success") is not True or sync_status != 200 \
                or "responseDetail" in (answer or {}):
            wrong.append(f"before archiving: register HTTP {status} {item}, sync HTTP {sync_status} {answer}")
        supabase_client.table("devices").update({"is_archived": True}).eq("id", uuid).execute()
        archived = True
        time.sleep(3)  # past I3X_ADDRESS_SPACE_TTL_SECONDS, so the next read is fresh
        status, answer = i3x_request("POST", "/subscriptions/sync", ctx.token, ids)
        detail = (answer or {}).get("responseDetail") or {}
        delivered = [u.get("elementId") for batch in (answer or {}).get("result") or []
                     for u in (batch.get("updates") or [])]
        if (status != 206 or detail.get("title") != "Elements left this caller's view"
                or device not in (detail.get("detail") or "") or device in delivered):
            wrong.append(f"after archiving: sync HTTP {status}, responseDetail {detail}, delivered {delivered}")
        status, answer = i3x_request("POST", "/subscriptions/list", ctx.token,
                                     {**client, "subscriptionIds": [sub]})
        entry = ((answer or {}).get("results") or [{}])[0].get("result") or {}
        if status != 200 or entry.get("monitoredObjects") != []:
            wrong.append(f"list: HTTP {status}, still monitoring {entry.get('monitoredObjects')}")
        status, answer = i3x_request("POST", "/subscriptions/sync", ctx.token, ids)
        if status != 200 or (answer or {}).get("result") != []:
            wrong.append(f"the next sync: HTTP {status} {answer}, expected 200 with no updates")
        status, item = register()
        if item.get("success") is not False or (item.get("responseDetail") or {}).get("status") != 404:
            wrong.append(f"registering it again: HTTP {status} {item}, expected a per-item 404")
    finally:
        if archived:
            restored = supabase_client.table("devices").update({"is_archived": False}).eq(
                "id", uuid).execute().data or [{}]
            if restored[0].get("is_archived") is not False:
                wrong.append(f"{device} could not be restored from the archive")
        status, answer = i3x_request("POST", "/subscriptions/delete", ctx.token,
                                     {**client, "subscriptionIds": [sub]})
        if status != 200 or ((answer or {}).get("results") or [{}])[0].get("success") is not True:
            wrong.append(f"deleting the subscription: HTTP {status} {answer}")
    if wrong:
        return False, "; ".join(wrong)
    return True, (f"archiving {device} withdrew it from its subscription with one 206 naming it, left "
                  f"nothing monitored, and a second registration is a 404")


# The order they run and print in. To add one: write a function beside these, list it here, and raise
# the count ingestion/README.md claims (check-docs-drift check 7). The letters stop at 12z.
I3X_CHECKS = (
    ("12a. i3X READ-ONLY", check_i3x_read_only),
    ("12b. i3X FAIL-CLOSED", check_i3x_fail_closed),
    ("12c. i3X ADDRESS SPACE", check_i3x_address_space),
    ("12d. i3X SINGLE ROOT", check_i3x_single_root),
    ("12e. i3X LIVE VALUES", check_i3x_live_values),
    ("12f. i3X VALUES ARE RLS-SCOPED", check_i3x_values_rls_scoped),
    ("12g. i3X PARENT IS THE RESOLVED CELL", check_i3x_parent_is_resolved_cell),
    ("12h. i3X REFUSES A NON-TOKEN", check_i3x_refuses_a_non_token),
    ("12i. i3X NAMESPACE FILTER", check_i3x_namespace_filter),
    ("12j. i3X SOURCE TYPE", check_i3x_source_type),
    ("12k. i3X CONTAINER VALUES", check_i3x_container_values),
    ("12l. i3X INVALID INPUT IS A 400", check_i3x_invalid_input),
    ("12m. i3X SERVER VERSION", check_i3x_server_version),
    ("12n. i3X HEARTBEAT IN UTC", check_i3x_heartbeat_in_utc),
    ("12o. i3X SIGNED INTEGERS", check_i3x_signed_integers),
    ("12p. i3X DEVICE TYPED BY EVERY SCHEMA", check_i3x_device_typed_by_every_schema),
    ("12q. i3X METRICS ARE COMPONENTS", check_i3x_metrics_are_components),
    ("12r. i3X TYPES AND NAMESPACES", check_i3x_types_and_namespaces),
    ("12s. i3X METRIC VALUES", check_i3x_metric_values),
    ("12t. i3X LOCATION TREE", check_i3x_location_tree),
    ("12u. i3X SITE NAME", check_i3x_site_name),
    ("12v. i3X LOCATION VALUES", check_i3x_location_values),
    ("12w. i3X HISTORY NAMES ITS METRICS", check_i3x_history_names_its_metrics),
    ("12x. i3X HISTORY CARRIES FORWARD", check_i3x_history_carries_forward),
    ("12y. i3X HISTORY BOUNDS", check_i3x_history_bounds),
    # Last: it archives a device.
    ("12z. i3X SUBSCRIPTION FOLLOWS ITS OWNER", check_i3x_subscription_follows_its_owner),
)


def verify_i3x(token):
    """Check 12 and its letters. Returns True when none failed."""
    status, answer = i3x_request("GET", "/info")
    info = answer.get("result", answer) if status == 200 and isinstance(answer, dict) else {}
    if not info.get("specVersion"):
        print(f"❌ 12.  i3X SERVER FAIL: /info returned HTTP {status} from {I3X_BASE_URL}. It MUST be "
              "reachable with no credentials -- it is the capabilities document and the health check.")
        return False
    print(f"✅ 12.  i3X SERVER: /info answers unauthenticated, specVersion {info['specVersion']}, "
          f"serverName {info.get('serverName')}")
    if not token:
        print("❌ 12.  i3X SERVER FAIL: no access token for the seeded administrator (see check 11c), "
              "so nothing behind authentication was checked.")
        return False

    return run_i3x_checks(I3xContext(token, info), I3X_CHECKS)


def run_i3x_checks(ctx, checks):
    """Run and print each (label, check) in order. Returns True when none failed."""
    passed = True
    for label, check in checks:
        try:
            ok, detail = check(ctx)
        except Exception as err:
            ok, detail = False, f"{type(err).__name__}: {err}"
        if ok is None:
            print(f"⚠️  {label}: skipped, {detail}")
        elif ok:
            print(f"✅ {label}: {detail}")
        else:
            print(f"❌ {label} FAIL: {detail}")
            passed = False
    return passed


# =================================================================================================
# Check 17: i3X quality and subscriptions, against what this run publishes
# =================================================================================================
# What check 12 cannot assert, since it publishes nothing of its own: quality against the
# Directory's liveness, which updates each kind of registration receives, and a death and a birth
# reaching a subscriber. Each takes the I3xContext, with `publisher` connected as the seeded gateway
# and `subscriptions` holding what it made, and returns what 12's return. Each deletes its
# subscriptions and brings back what it killed in a `finally`; 17g, which kills the gateway, runs
# last of all.

# How long a check waits for the i3X server to act on a message it published.
I3X_WAIT_SECONDS = 10.0


def i3x_publish(ctx, msg_type, device_id=None, metrics=None):
    """One Sparkplug message as the seeded gateway: the node's own with no device, else the device's."""
    gw = SEEDED.get("gateway_id") or VAL_GW_NAME
    at_ms = int(time.time() * 1000)
    if device_id:
        ctx.publisher.publish(f"spBv1.0/{VAL_GROUP}/{msg_type}/{gw}/{device_id}",
                              make_sparkplug_payload(device_id, metrics or {}, at_ms))
    else:
        ctx.publisher.publish(f"spBv1.0/{VAL_GROUP}/{msg_type}/{gw}", make_node_birth_payload({}, at_ms))


def i3x_subscribe(ctx, *registrations):
    """A new subscription under VAL_LIVE_CLIENT holding each (elementId, maxDepth), in `ctx`'s list
    for deletion. Raises, naming the answer, when the create or a registration fails."""
    status, answer = i3x_request("POST", "/subscriptions", ctx.token, {"clientId": VAL_LIVE_CLIENT})
    sub = ((answer or {}).get("result") or {}).get("subscriptionId")
    if status != 200 or not sub:
        raise RuntimeError(f"POST /subscriptions answered {status}: {answer}")
    ctx.subscriptions.append(sub)
    for element_id, depth in registrations:
        status, answer = i3x_request("POST", "/subscriptions/register", ctx.token, {
            "clientId": VAL_LIVE_CLIENT, "subscriptionId": sub, "elementIds": [element_id],
            "maxDepth": depth})
        item = ((answer or {}).get("results") or [{}])[0]
        if status != 200 or item.get("success") is not True:
            raise RuntimeError(f"registering {element_id} at maxDepth {depth} answered {status}: {item}")
    return sub


def i3x_unsubscribe(ctx):
    """Delete every subscription in `ctx`'s list. Returns a problem per failure, else []."""
    subs, ctx.subscriptions = list(ctx.subscriptions), []
    if not subs:
        return []
    status, answer = i3x_request("POST", "/subscriptions/delete", ctx.token,
                                 {"clientId": VAL_LIVE_CLIENT, "subscriptionIds": subs})
    deleted = [r.get("subscriptionId") for r in (answer or {}).get("results") or []
               if r.get("success") is True]
    if status != 200 or sorted(deleted) != sorted(subs):
        return [f"deleting {len(subs)} subscription(s) answered HTTP {status}: {answer}"]
    return []


def i3x_updates(ctx, sub, until=None):
    """The updates queued on `sub` as (sequenceNumber, elementId, value, quality), synced without
    acknowledging until `until(updates)` holds or I3X_WAIT_SECONDS pass, then acknowledged. With no
    `until`, one read."""
    body = {"clientId": VAL_LIVE_CLIENT, "subscriptionId": sub}
    deadline = time.monotonic() + I3X_WAIT_SECONDS
    while True:
        status, answer = i3x_request("POST", "/subscriptions/sync", ctx.token, body)
        if status not in (200, 206):
            raise RuntimeError(f"/subscriptions/sync answered {status}: {answer}")
        updates = [(batch.get("sequenceNumber"), u.get("elementId"), u.get("value"), u.get("quality"))
                   for batch in answer.get("result") or [] for u in batch.get("updates") or []]
        if until is None or until(updates) or time.monotonic() > deadline:
            break
        time.sleep(0.5)
    if updates:
        i3x_request("POST", "/subscriptions/sync", ctx.token, dict(body, lastSequenceNumber=-1))
    return updates


def i3x_values_until(ctx, element_ids, until):
    """/objects/value for `element_ids`, read again until `until(values)` holds or I3X_WAIT_SECONDS
    pass. Returns the last values, by elementId."""
    deadline = time.monotonic() + I3X_WAIT_SECONDS
    while True:
        values = i3x_bulk("/objects/value", ctx.token, {"elementIds": list(element_ids)})
        if until(values) or time.monotonic() > deadline:
            return values
        time.sleep(0.5)


def status_of(vqt):
    """A gateway VQT's (status, quality)."""
    return ((vqt or {}).get("value") or {}).get("status"), (vqt or {}).get("quality")


def check_i3x_quality_follows_the_directory(ctx):
    wrong, gateways, quarantined = [], 0, []
    for key in seeded_keys("gateways"):
        element_id = SEEDED.get(key + "_id")
        rows = supabase_client.table("gateway_status").select("live_status").eq(
            "id", SEEDED[key + "_uuid"]).execute().data or []
        live = (rows[0].get("live_status") if rows else None)
        live = live.upper() if isinstance(live, str) else live
        status, _ = status_of(i3x_value(ctx.token, element_id))
        gateways += 1
        if status != live:
            wrong.append(f"gateway {element_id} reads {status!r} here and {live!r} in gateway_status")
    uuids = [SEEDED[key + "_uuid"] for key in seeded_keys("devices")]
    rows = supabase_client.table("devices").select("sparkplug_id").eq("is_quarantined", True).in_(
        "id", uuids).execute().data or []
    for row in rows:
        vqt = i3x_value(ctx.token, row["sparkplug_id"]) or {}
        held = vqt.get("value") is not None
        quarantined.append(f"{row['sparkplug_id']} {vqt.get('quality')}")
        if vqt.get("quality") != ("Uncertain" if held else "Bad"):
            wrong.append(f"quarantined {row['sparkplug_id']} is {vqt.get('quality')!r} "
                         f"{'with' if held else 'without'} a value, expected "
                         f"{'Uncertain' if held else 'Bad'}")
    if not rows:
        wrong.append("this run quarantined no device, so the quarantined rows were not compared")
    if wrong:
        return False, "; ".join(wrong)
    return True, (f"{gateways} gateway(s) read the gateway_status view's live status, and "
                  f"{len(rows)} quarantined device(s) are Uncertain with a value and Bad without "
                  f"({', '.join(quarantined)})")


def check_i3x_every_value_is_well_formed(ctx):
    element_ids, checked, gone, wrong = sorted(ctx.objects), 0, 0, []
    for start in range(0, len(element_ids), 200):
        status, answer = i3x_request("POST", "/objects/value", ctx.token,
                                     {"elementIds": element_ids[start:start + 200], "maxDepth": 0})
        if status not in (200, 206):
            wrong.append(f"/objects/value answered {status} for {len(element_ids[start:start + 200])} ids")
            continue
        for item in (answer or {}).get("results") or []:
            if not item.get("success"):
                if (item.get("responseDetail") or {}).get("status") == 404:
                    gone += 1  # left the address space since check 12 listed it
                else:
                    wrong.append(f"{item.get('elementId')}: {item.get('responseDetail')}")
                continue
            result = item.get("result") or {}
            for element_id, vqt in [(item.get("elementId"), result),
                                    *(result.get("components") or {}).items()]:
                checked += 1
                if vqt.get("timestamp") is None:
                    wrong.append(f"{element_id} has a null timestamp")
                if vqt.get("value") is None and vqt.get("quality") in ("Good", "Uncertain"):
                    wrong.append(f"{element_id} pairs a null value with {vqt.get('quality')}")
    if not checked:
        wrong.append(f"no value was read for the {len(element_ids)} objects")
    if wrong:
        return False, "; ".join(wrong[:8]) + (f" (and {len(wrong) - 8} more)" if len(wrong) > 8 else "")
    return True, (f"{checked} values and components of {len(element_ids)} objects at maxDepth 0 each "
                  f"have a timestamp, and none pairs null with Good or Uncertain"
                  + (f" ({gone} gone since 12 listed them)" if gone else ""))


def check_i3x_stored_history_is_good(ctx):
    known = SEEDED.get("known_id")
    now_ms = int(time.time() * 1000)
    status, answer = i3x_request("POST", "/objects/history", ctx.token, {
        "elementIds": [known], "startTime": iso_ms(now_ms - 3600_000), "endTime": iso_ms(now_ms)})
    item = ((answer or {}).get("results") or [{}])[0]
    values = (item.get("result") or {}).get("values") or []
    if status not in (200, 206) or not values:
        return False, f"the last hour of {known}'s history answered HTTP {status} with {len(values)} values"
    wrong = [(v.get("timestamp"), v.get("quality")) for v in values
             if v.get("quality") != ("Good" if v.get("value") is not None else "GoodNoData")]
    if wrong:
        return False, f"{len(wrong)} of {known}'s {len(values)} stored values are not Good: {wrong[:5]}"
    return True, f"all {len(values)} of {known}'s stored values in the last hour are Good"


def check_i3x_registration_requests(ctx):
    known, wrong = SEEDED.get("known_id"), []
    try:
        sub = i3x_subscribe(ctx)
        ids = {"clientId": VAL_LIVE_CLIENT, "subscriptionId": sub}

        def register(**fields):
            status, answer = i3x_request("POST", "/subscriptions/register", ctx.token, {**ids, **fields})
            return status, [
                (r.get("elementId"), r.get("success"), (r.get("responseDetail") or {}).get("status"))
                for r in (answer or {}).get("results") or []
            ]

        status, got = register(elementIds=[known, "i3x:nope", known], maxDepth=0)
        if (status, got) != (200, [(known, True, None), ("i3x:nope", False, 404), (known, True, None)]):
            wrong.append(f"[{known}, i3x:nope, {known}] answered HTTP {status} {got}, expected ok, 404, ok")
        status, got = register(elementIds=[known], maxDepth=1)
        if (status, got) != (200, [(known, True, None)]):
            wrong.append(f"registering {known} again answered HTTP {status} {got}, expected success")
        status, answer = i3x_request("POST", "/subscriptions/list", ctx.token,
                                     {"clientId": VAL_LIVE_CLIENT, "subscriptionIds": [sub]})
        listed = (((answer or {}).get("results") or [{}])[0].get("result") or {}).get("monitoredObjects")
        if listed != [{"elementId": known, "maxDepth": 0}]:
            wrong.append(f"after registering {known} at 0 then 1, list shows {listed}; "
                         "the first depth should stand")
        status, got = register(objects=[{"elementId": ["x"]}])
        if (status, got) != (200, [(["x"], False, 400)]):
            wrong.append(f"a non-string elementId answered HTTP {status} {got}, expected a per-item 400")
        status, _ = register(elementIds=[known], maxDepth="0")
        if status != 400:
            wrong.append(f'maxDepth "0" answered {status}, expected 400')
        status, _ = i3x_request("POST", "/subscriptions/sync", ctx.token,
                                {"clientId": VAL_LIVE_CLIENT, "subscriptionId": ["x"]})
        if status != 400:
            wrong.append(f"a non-string subscriptionId answered {status}, expected 400")
    finally:
        wrong += i3x_unsubscribe(ctx)
    if wrong:
        return False, "; ".join(wrong)
    return True, ("results pair with requests by position, a repeat keeps the first depth, and a "
                  "malformed elementId, maxDepth or subscriptionId is a 400")


def check_i3x_subscription_depth(ctx):
    known, cell = SEEDED.get("known_id"), SEEDED.get("cell_uuid")
    metric, wrong = f"{known}/Systems/TEMPERATURE", []

    def together(updates):
        batches = {}
        for seq, element_id, _value, _quality in updates:
            batches.setdefault(seq, set()).add(element_id)
        return any({known, metric} <= ids for ids in batches.values())

    def ids(updates):
        return sorted({element_id for _seq, element_id, _value, _quality in updates})

    try:
        unbounded, shallow = i3x_subscribe(ctx, (known, 0)), i3x_subscribe(ctx, (known, 1))
        alone, place = i3x_subscribe(ctx, (metric, 1)), i3x_subscribe(ctx, (cell, 0))
        i3x_publish(ctx, "DDATA", known, {"Systems/TEMPERATURE": 44.5})
        got = i3x_updates(ctx, unbounded, together)
        if not together(got):
            wrong.append(f"{known} at maxDepth 0 received {ids(got)}, not it and {metric} in one batch")
        got = i3x_updates(ctx, shallow, bool)
        if ids(got) != [known]:
            wrong.append(f"{known} at maxDepth 1 received {ids(got)}, expected only itself")
        got = i3x_updates(ctx, alone, bool)
        if ids(got) != [metric] or [v for _s, _e, v, _q in got][-1:] != [44.5]:
            wrong.append(f"{metric} registered alone received {got}, expected only itself at 44.5")
        got = i3x_updates(ctx, place)
        if got:
            wrong.append(f"the cell {cell} at maxDepth 0 received {ids(got)}, expected nothing")
    finally:
        wrong += i3x_unsubscribe(ctx)
    if wrong:
        return False, "; ".join(wrong)
    return True, (f"one DDATA reached {known} at maxDepth 0 with {metric} in one batch, at maxDepth 1 "
                  f"as its map only, the metric registered alone as itself, and its cell not at all")


def check_i3x_device_death_and_birth(ctx):
    known, wrong, dead = SEEDED.get("known_id"), [], False

    def seen(updates, quality):
        return [(q, v is not None) for _s, e, v, q in updates if e == known and q == quality]

    try:
        sub = i3x_subscribe(ctx, (known, 1))
        i3x_publish(ctx, "DDEATH", known)
        dead = True
        got = i3x_updates(ctx, sub, lambda updates: seen(updates, "Uncertain"))
        if ("Uncertain", True) not in seen(got, "Uncertain"):
            wrong.append(f"after its DDEATH, {known}'s subscriber received "
                         f"{[(e, q) for _s, e, _v, q in got]}, not its values held Uncertain")
        i3x_publish(ctx, "DBIRTH", known, VAL_KNOWN_BIRTH)
        dead = False
        got = i3x_updates(ctx, sub, lambda updates: seen(updates, "Good"))
        if not seen(got, "Good"):
            wrong.append(f"after its DBIRTH, {known}'s subscriber received "
                         f"{[(e, q) for _s, e, _v, q in got]}, not Good")
    finally:
        if dead:
            i3x_publish(ctx, "DBIRTH", known, VAL_KNOWN_BIRTH)
        wrong += i3x_unsubscribe(ctx)
    if wrong:
        return False, "; ".join(wrong)
    return True, f"{known}'s subscriber received its values Uncertain on DDEATH and Good on DBIRTH"


def check_i3x_gateway_death_and_birth(ctx):
    # Last: it kills the seeded gateway, and brings it and the registered device back.
    gateway, known = SEEDED.get("gateway_id"), SEEDED.get("known_id")
    wrong, dead = [], False

    def announced(updates, status):
        return [q for _s, e, v, q in updates if e == gateway and status_of({"value": v})[0] == status]

    try:
        sub = i3x_subscribe(ctx, (gateway, 1))
        i3x_publish(ctx, "NDEATH")
        dead = True
        got = i3x_updates(ctx, sub, lambda updates: announced(updates, "OFFLINE"))
        if "Good" not in announced(got, "OFFLINE"):
            wrong.append(f"after its NDEATH, {gateway}'s subscriber received "
                         f"{[(e, status_of({'value': v})[0], q) for _s, e, v, q in got]}")
        values = i3x_values_until(ctx, [gateway, known], lambda values: (
            status_of(values.get(gateway)) == ("OFFLINE", "Good")
            and (values.get(known) or {}).get("quality") == "Uncertain"))
        if status_of(values.get(gateway)) != ("OFFLINE", "Good"):
            wrong.append(f"after its NDEATH, {gateway} reads {status_of(values.get(gateway))}")
        if (values.get(known) or {}).get("quality") != "Uncertain":
            wrong.append(f"after its gateway's NDEATH, {known} reads "
                         f"{(values.get(known) or {}).get('quality')}")
        i3x_publish(ctx, "NBIRTH")
        i3x_publish(ctx, "DBIRTH", known, VAL_KNOWN_BIRTH)
        dead = False
        got = i3x_updates(ctx, sub, lambda updates: announced(updates, "ONLINE"))
        if "Good" not in announced(got, "ONLINE"):
            wrong.append(f"after its NBIRTH, {gateway}'s subscriber received "
                         f"{[(e, status_of({'value': v})[0], q) for _s, e, v, q in got]}")
        values = i3x_values_until(ctx, [gateway, known], lambda values: (
            status_of(values.get(gateway)) == ("ONLINE", "Good")
            and (values.get(known) or {}).get("quality") == "Good"))
        if status_of(values.get(gateway)) != ("ONLINE", "Good") \
                or (values.get(known) or {}).get("quality") != "Good":
            wrong.append(f"after NBIRTH and DBIRTH, {gateway} reads {status_of(values.get(gateway))} "
                         f"and {known} {(values.get(known) or {}).get('quality')}")
    finally:
        if dead:
            i3x_publish(ctx, "NBIRTH")
            i3x_publish(ctx, "DBIRTH", known, VAL_KNOWN_BIRTH)
        wrong += i3x_unsubscribe(ctx)
    if wrong:
        return False, "; ".join(wrong)
    return True, (f"{gateway}'s NDEATH reached its subscriber as OFFLINE and Good, held {known} "
                  f"Uncertain, and its NBIRTH brought both back to Good")


# The order they run and print in; 17g last. The same conventions as I3X_CHECKS.
I3X_LIVE_CHECKS = (
    ("17a. i3X QUALITY FOLLOWS THE DIRECTORY", check_i3x_quality_follows_the_directory),
    ("17b. i3X EVERY VALUE IS WELL-FORMED", check_i3x_every_value_is_well_formed),
    ("17c. i3X STORED HISTORY IS GOOD", check_i3x_stored_history_is_good),
    ("17d. i3X REGISTRATION REQUESTS", check_i3x_registration_requests),
    ("17e. i3X SUBSCRIPTION DEPTH", check_i3x_subscription_depth),
    ("17f. i3X DEVICE DEATH AND BIRTH", check_i3x_device_death_and_birth),
    # Last: it kills the seeded gateway.
    ("17g. i3X GATEWAY DEATH AND BIRTH", check_i3x_gateway_death_and_birth),
)


def verify_i3x_live(token):
    """Check 17 and its letters. Returns True when none failed."""
    if not token:
        print("❌ 17.  i3X LIVE FAIL: no access token for the seeded administrator (see check 11c), "
              "so nothing was checked.")
        return False
    # Check 12 and the checks since took minutes: a value is Good only while its gateway has beaten
    # within 90 s and its device is ONLINE.
    freshen_the_plant()
    publisher = connect_publisher(capture=False)
    if publisher is None:
        print("❌ 17.  i3X LIVE FAIL: could not connect to the broker as the seeded gateway, so "
              "nothing was published.")
        return False
    print(f"✅ 17.  i3X LIVE: publishing as the seeded gateway {SEEDED.get('gateway_id') or VAL_GW_NAME}")
    ctx = I3xContext(token, {})
    ctx.publisher, ctx.subscriptions = publisher, []
    try:
        return run_i3x_checks(ctx, I3X_LIVE_CHECKS)
    finally:
        for problem in i3x_unsubscribe(ctx):
            print(f"⚠️  17.  i3X LIVE: {problem}")
        publisher.loop_stop()
        publisher.disconnect()


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
            # rebirth would append an audit_trail entry saying nothing changed.
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

        # 2. Verify Audit Trail triggers. Scoped to the entities this run created; asserting the
        # whole table is non-empty would pass on audit rows from any source. Both actions are
        # required because log_audit_trail_event() serves INSERT, UPDATE and DELETE, and the run
        # performs the first two.
        try:
            run_entity_ids = [
                SEEDED[key] for key in ("cell_uuid", "gateway_uuid", "known_uuid", "legacy_uuid",
                                        "mismatch_uuid", "alias_uuid")
                if SEEDED.get(key)
            ]
            if not run_entity_ids:
                print("❌ 2. AUDIT TRAIL TRIGGERS FAIL: no seeded entity ids to check against.")
                passed = False
            else:
                res_trail = supabase_client.table("audit_trail").select(
                    "entity_type,entity_id,action"
                ).in_("entity_id", run_entity_ids).execute()
                logs = res_trail.data if res_trail else []
                actions = {row.get("action") for row in logs}
                if "INSERT" in actions and "UPDATE" in actions:
                    print(f"✅ 2. AUDIT TRAIL TRIGGERS: {len(logs)} audit entries written for this run's "
                          f"{len(run_entity_ids)} entities, covering {', '.join(sorted(actions))}.")
                elif logs:
                    print(f"❌ 2. AUDIT TRAIL TRIGGERS FAIL: {len(logs)} entries for this run's entities but "
                          f"actions were {sorted(actions)}; expected both INSERT and UPDATE.")
                    passed = False
                else:
                    print("❌ 2. AUDIT TRAIL TRIGGERS FAIL: no audit entries for any entity this run created.")
                    passed = False
        except Exception as e:
            print(f"❌ 2. AUDIT TRAIL TRIGGERS ERROR: {e}")
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

            # 10a. Written once, not once per sweep tick: log_audit_trail_event() fires on every
            # UPDATE to `devices`, so a watchdog rewriting OFFLINE each tick would append to the
            # audit table forever.
            audit = supabase_client.table("audit_trail").select("id,new_data").eq(
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

            # 10b. The timeout rests on silence alone, so the device's next DDATA sets it ONLINE
            # again without a birth.
            publisher = connect_publisher(capture=False) if status == "OFFLINE" else None
            if status == "OFFLINE" and publisher is None:
                print("❌ 10b. DEVICE PUBLISHES AGAIN FAIL: could not connect to the broker as the "
                      "seeded gateway, so nothing was published.")
                passed = False
            elif publisher is not None:
                alias_dev = SEEDED["alias_id"]
                gw = SEEDED.get("gateway_id") or VAL_GW_NAME
                publisher.publish(f"spBv1.0/{VAL_GROUP}/DDATA/{gw}/{alias_dev}", make_sparkplug_payload(
                    alias_dev, {"Systems/TEMPERATURE": 20.5}, int(time.time() * 1000)))
                time.sleep(4)
                publisher.loop_stop()
                publisher.disconnect()
                res = supabase_client.table("devices").select("status").eq(
                    "id", SEEDED["alias_uuid"]
                ).execute()
                revived = res.data[0]["status"] if res.data else None
                if revived == "ONLINE":
                    print("✅ 10b. DEVICE PUBLISHES AGAIN: DDATA from the timed-out device set it "
                          "ONLINE without a birth.")
                else:
                    print(f"❌ 10b. DEVICE PUBLISHES AGAIN FAIL: status is '{revived}' after DDATA "
                          "from a device the watchdog timed out; expected ONLINE. The daemon's log "
                          "says why under 'WATCHDOG' or 'has not been born since'.")
                    passed = False
        except Exception as e:
            print(f"❌ 10. DEVICE WATCHDOG ERROR: {e}")
            passed = False

    # One sign-in for everything behind authentication: checks 11c-11e, 12 and 17.
    token, auth_err = sign_in_admin()

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
        if auth_err:
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

    # 12. The i3X server, against the Directory: see verify_i3x().
    try:
        freshen_the_plant()
        if not verify_i3x(token):
            passed = False
    except Exception as e:
        print(f"❌ 12.  i3X SERVER ERROR: {type(e).__name__}: {e}")
        passed = False

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

    # 17. The i3X server's quality and subscriptions, against what this run publishes: see
    # verify_i3x_live(). Last, because 17g kills the seeded gateway before bringing it back.
    try:
        if not verify_i3x_live(token):
            passed = False
    except Exception as e:
        print(f"❌ 17.  i3X LIVE ERROR: {type(e).__name__}: {e}")
        passed = False

    return passed


def print_verdict(passed):
    print("==========================================")
    if passed:
        print("🎉 END-TO-END VALIDATION PASSED SUCCESSFULLY!")
    else:
        print("💥 END-TO-END VALIDATION FAILED!")


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
        failures = cleanup_validation_data()
        for failure in failures:
            print(f"❌ CLEANUP: {failure}")
        sys.exit(0 if (admin_ok and not failures) else 1)

    success = False
    try:
        # Rows an interrupted run left in the Directory. This run's own come out at check 16.
        for failure in cleanup_validation_data():
            print(f"⚠️  PRE-RUN CLEANUP: {failure}")
        seed_supabase()
        run_simulation()
        success = verify_results()
    finally:
        # 16. Reported as an outcome, before the verdict: a cleanup that fails leaves this run's rows
        # for the next one, which then starts dirty.
        if args.keep_data:
            print("⚠️  16. CLEANUP: skipped, --keep-data. `validate.py --cleanup` removes the rows.")
        else:
            success = report_cleanup(cleanup_validation_data()) and success
        print_verdict(success)

    sys.exit(0 if (success and admin_ok) else 1)
