"""
The AAS conformance suites' own subject, provisioned at pinned ids.

WHY THIS EXISTS. Both AAS suites used to export `Sim_CNC_Mill_01` -- a device seeded by
`0002_seed_data.sql` as part of the demonstration shopfloor. That coupled a conformance suite to
demo data, and the seed no longer creates it. It has also bitten once already: archived
`0020_cleanup_legacy_simulator_seed.sql` existed partly because the suite's previous subject,
`Simulated_CNC_01`, quietly stopped receiving a DBIRTH while the suite went on naming it.

THE PATTERN IS `ingestion/validate.py`'s, deliberately. That suite seeds its own gateway at a pinned
UUID and creates its own devices at runtime, which is why CI can say the AAS suite "has no data
dependency on validate.py at all". A conformance suite that provisions its own subject was a solved
problem in this repository; the AAS one simply had not been moved onto it.

WHAT IT DOES NOT PROVISION, and must not: `metric_catalog`. The metrics below are the example
metrics (`supabase/example-metrics.sql`, which values-dev.yaml loads), registered with their
semantic ids and their `standard` values, and they are what the exporter reads to decide
provenance -- an ISO 22400 metric becomes a KeyPerformanceIndicators submodel, everything else
becomes OperationalTelemetry. Inventing metrics
here would make the suite assert against a catalogue no device could ever publish against.

IDS ARE PINNED for the reason validate.py pins its gateway: a run that dies before teardown leaves
rows behind, and a plain INSERT would then fail on the primary key from then on, permanently. Every
write below is an upsert.
"""
import json
import urllib.error
import urllib.parse
import urllib.request

# Distinct from validate.py's 11.../22... block and from 0002's seed ids, so a stale row from one
# suite can never be mistaken for -- or collide with -- the other's.
GATEWAY_UUID = "1a000000-0000-4000-8000-000000000001"
DEVICE_UUID = "2a000000-0000-4000-8000-000000000001"

GATEWAY_NAME = "AAS_Conformance_Gateway"
DEVICE_NAME = "AAS_Conformance_Device"
SCHEMA_NAME = "AAS_Conformance_Schema"
CELL_NAME = "AAS Conformance Cell"

# Split across the two provenances the exporter keys on. AT LEAST ONE OF EACH IS REQUIRED: with no
# ISO 22400 metric there is no KeyPerformanceIndicators submodel and the suite's
# `test_composes_the_three_expected_submodels` fails for a reason that has nothing to do with the
# exporter.
TELEMETRY_METRICS = ["Systems/TEMPERATURE", "Controller/EXECUTION", "SERIAL_NUMBER",
                     "Controller/FIRMWARE"]
KPI_METRICS = ["OEE/AVAILABILITY", "OEE/EFFECTIVENESS", "OEE/QUALITY"]

# Birth parameters, as ingestion would have written them from a DBIRTH. The nameplate resolves
# device-first, so these are what make SerialNumber and FirmwareVersion carry a device's own answer
# rather than the operator's -- which is the branch `test_nameplate_carries_identity` exercises.
BIRTH_VALUES = {
    "SERIAL_NUMBER": ("val_string", "AAS-CONF-0001"),
    "Controller/FIRMWARE": ("val_string", "v9.9.9-conformance"),
    "Systems/TEMPERATURE": ("val_double", 42.5),
    "Controller/EXECUTION": ("val_string", "ACTIVE"),
    "OEE/AVAILABILITY": ("val_double", 0.95),
    "OEE/EFFECTIVENESS": ("val_double", 0.88),
    "OEE/QUALITY": ("val_double", 0.99),
}

NAMEPLATE = {
    "manufacturer_name": "Aber Conformance",
    "manufacturer_product_designation": "AAS Conformance Fixture",
    "manufacturer_product_type": "Conformance test subject",
    "year_of_construction": "2026",
    "hardware_version": "v1.0",
    "software_version": "v1.0",
    "country_of_origin": "GB",
}


class FixtureError(RuntimeError):
    """Provisioning failed. Raised rather than returned: a suite running against a half-built
    subject reports exporter faults that are really fixture faults."""


def _request(base, token, anon, method, path, payload=None, headers=None):
    url = f"{base}/rest/v1{path}"
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("apikey", anon)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read()
            return json.loads(raw) if raw else []
    except urllib.error.HTTPError as err:
        detail = (err.read() or b"").decode(errors="replace")[:300]
        raise FixtureError(f"{method} {path} -> HTTP {err.code}: {detail}") from err


def _upsert(base, token, anon, table, payload, on_conflict=None):
    path = f"/{table}"
    if on_conflict:
        path += f"?on_conflict={on_conflict}"
    return _request(
        base, token, anon, "POST", path, payload,
        {"Prefer": "resolution=merge-duplicates,return=representation"},
    )


def ensure(base, token, anon):
    """
    Provision the subject and return its row. Idempotent.

    ORDER IS A DEPENDENCY, the same one 0020 records: the schema must be attached before anything
    reads the device, and `asset_config` is keyed by the TEXT `sparkplug_id`, which does not exist
    until the device row does.
    """
    cells = _upsert(base, token, anon, "cells", {"name": CELL_NAME}, on_conflict="name")
    cell_id = cells[0]["id"] if cells else None

    _upsert(base, token, anon, "gateways", {
        "id": GATEWAY_UUID, "name": GATEWAY_NAME, "cell_id": cell_id,
        "status": "ONLINE", "deployment": "host",
    }, on_conflict="id")

    devices = _upsert(base, token, anon, "devices", {
        "id": DEVICE_UUID, "name": DEVICE_NAME, "gateway_id": GATEWAY_UUID,
        # OFFLINE, not ONLINE: status is what ingestion has observed, and devices_online_implies_born
        # (0119) refuses ONLINE for a device with no first_dbirth_at, which a provisioned one has.
        "status": "OFFLINE", "is_quarantined": False, "cell_id": cell_id,
        "connection_method": "MQTT / Sparkplug B",
    }, on_conflict="id")
    if not devices:
        raise FixtureError("device upsert returned no row")
    device = devices[0]

    schemas = _upsert(base, token, anon, "schemas", {
        "schema_name": SCHEMA_NAME,
        "description": "Subject of the AAS V3 conformance suites. Provisioned at runtime.",
        "schema_definition": {
            "type": "object",
            "required": TELEMETRY_METRICS,
            "properties": {
                **{m: {"type": "number" if m.startswith(("Systems", "OEE")) else "string"}
                   for m in TELEMETRY_METRICS + KPI_METRICS},
            },
        },
        "status": "active",
    }, on_conflict="schema_name")
    schema_id = schemas[0]["id"]

    # device_submodels rather than devices.schema_id: the join table is the current path and the
    # 1:1 column is the archived fallback. Attaching through the join is what the exporter's
    # `device_schemas` view unions, and what an operator's UI edit writes.
    existing = _request(
        base, token, anon, "GET",
        f"/device_submodels?device_id=eq.{DEVICE_UUID}&schema_id=eq.{schema_id}&select=id",
    )
    if not existing:
        _request(base, token, anon, "POST", "/device_submodels", {
            "device_id": DEVICE_UUID, "schema_id": schema_id,
        })

    _upsert(base, token, anon, "device_nameplate",
            {"device_id": DEVICE_UUID, **NAMEPLATE}, on_conflict="device_id")

    # asset_config is keyed by sparkplug_id -- a GENERATED column, so it is only knowable after the
    # device row exists. This is what ingestion writes from a DBIRTH; the suite needs it because the
    # nameplate resolves device-published values ahead of operator-recorded ones.
    sparkplug_id = device["sparkplug_id"]
    for name, (column, value) in BIRTH_VALUES.items():
        _upsert(base, token, anon, "asset_config", {
            "asset_id": sparkplug_id, "metric_name": name, column: value,
        }, on_conflict="asset_id,metric_name")

    return device


def teardown(base, token, anon):
    """
    Remove the subject. Best effort: a failure here must not fail a suite that passed.

    `audit_trail` is deliberately NOT touched -- it is append-only by design, and these deletes
    APPEND to it. See 0020: "the purge is itself recorded".
    """
    for path in (
        f"/asset_config?asset_id=like.dev*&metric_name=in.({','.join(BIRTH_VALUES)})",
        f"/device_submodels?device_id=eq.{DEVICE_UUID}",
        f"/device_nameplate?device_id=eq.{DEVICE_UUID}",
        f"/devices?id=eq.{DEVICE_UUID}",
        f"/gateways?id=eq.{GATEWAY_UUID}",
        f"/schemas?schema_name=eq.{urllib.parse.quote(SCHEMA_NAME)}",
        f"/cells?name=eq.{urllib.parse.quote(CELL_NAME)}",
    ):
        try:
            _request(base, token, anon, "DELETE", path)
        except FixtureError:
            pass
