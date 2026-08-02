# Ingestion Engine

The Python daemon that consumes Sparkplug B traffic from Mosquitto and routes it to two different
stores: **asset metadata to Supabase**, **time-series telemetry to TimescaleDB**.

It is the only component that writes telemetry, and the only one that decides whether a device is
allowed to be heard at all.

| File | Purpose |
| :--- | :--- |
| [`ingestion.py`](ingestion.py) | The daemon. Identity resolution, quarantine gating, telemetry mapping |
| [`validate.py`](validate.py) | End-to-end validator — publishes real Sparkplug payloads and asserts 20 outcomes |
| [`logging_config.py`](logging_config.py) | Structured logger used by both |
| [`test_gateway_binding.py`](test_gateway_binding.py) | Gateway↔device binding, telemetry sanity window, append-only historian |
| [`test_declared_metrics.py`](test_declared_metrics.py) | Birth-metric observation, change-only writes |
| [`test_device_location.py`](test_device_location.py) | Invariant: the daemon never writes an asset's location |

---

## Data Flow

```
Sparkplug B device
      │  DBIRTH / DDATA / DDEATH  on  spBv1.0/<group>/<type>/<edge_node>/<device>
      ▼
  Mosquitto ──── mosquitto.acl confines each gateway to spBv1.0/+/+/<own-id>/#
      │
      ▼  subscribe spBv1.0/#
  ingestion.py
      ├── resolve_wire_identity()     the TOPIC is authoritative
      ├── resolve_device()            sparkplug_id → reported_identity → legacy name
      ├── verify_gateway_binding()    is this publisher allowed to speak for this device?
      │
      ├──► Supabase        devices, asset_config, gateways.last_heartbeat
      └──► TimescaleDB     telemetry hypertable, keyed by sparkplug_id
```

---

## Asset Identity on the Wire

Every gateway and device carries an immutable **`sparkplug_id`**: a 3-character type prefix
(`gwy` / `dev`) plus 21 lowercase hex characters, 24 in total. It is a `GENERATED ALWAYS … STORED`
column derived from the row's UUID primary key, so it cannot drift.

- **This is the identity on the wire.** It appears in the MQTT topic and keys `telemetry.asset_id`.
- **`name` is a display label.** Freely editable, not unique. Renaming never detaches telemetry.
- **The topic is authoritative**; the `Asset_ID` payload metric is a cross-check. A disagreement
  quarantines the device rather than letting one silently win.
- **Malformed identifiers quarantine with a diagnosis** (`quarantine_reason`), never dropped. The
  fixed width is what lets a truncated id be reported as truncated rather than as unknown.

### Resolution precedence

`resolve_device()` tries, in order:

1. **`sparkplug_id`** — the platform-issued id, the current scheme.
2. **`reported_identity`** — a third-party device's own factory-preset id, recorded when it was
   discovered. Such a device cannot be made to publish an issued id, so its own must keep resolving.
3. **`name`** — legacy, pre-`sparkplug_id` devices. Warns, and flags the row `identity_source =
   'legacy_name'`. **This arm goes away once every gateway has been reconfigured.**

Any failure resolves to `None`, which callers treat as quarantined — the fail-closed answer.

---

## Gateway Binding

`verify_gateway_binding()` rejects a message whose publishing edge node is not the one the device
is bound to (`devices.gateway_id`).

**Why it exists.** A `sparkplug_id` is an identifier, not a secret — it is derived from the row's
UUID, shown in the dashboard, and present in every topic. Before this check, the topic's device
segment was the only thing consulted, so any edge node authenticated to the broker could publish
under any device's id. Three consequences, in ascending severity:

1. forge another machine's telemetry into the historian;
2. flip another machine `ONLINE` with a fabricated DBIRTH;
3. publish a contradictory `Asset_ID` for a device you do not own, forcing it into quarantine —
   which silently stops its real telemetry being stored. **A denial of service against a production
   asset, triggered by one message.**

[`mosquitto.acl`](../mosquitto.acl) closes the same hole at the broker tier. **Both are needed**:
the broker cannot know which device belongs to which gateway (that lives in Supabase), and the
daemon cannot stop a forged message being delivered to other subscribers.

### Three cases are deliberately not a mismatch

| Case | Why |
| :--- | :--- |
| Device with no `gateway_id` | Binding is established by an operator at approval, not by ingestion. An unbound device is unbound, not mis-bound |
| Device resolved by legacy `name` | Its row may predate any gateway assignment; enforcing here would break the deployments the fallback exists to carry |
| Node-level message (`NBIRTH`/`NDATA`/`NDEATH`) | Carries no device segment; handled by `process_node_message()` |

On **DBIRTH** a binding fault re-quarantines the device with a `GATEWAY_MISMATCH` reason.
On **DDATA** it is dropped, not quarantined — a DDATA stream carries no birth certificate, so there
is nothing for an operator to inspect, and letting an unbound publisher quarantine a healthy device
would hand it the very denial of service the check exists to prevent.

---

## Quarantine

Unregistered devices are **auto-inserted with `is_quarantined = true`** rather than dropped —
silently discarding a misconfigured gateway makes it invisible instead of diagnosable.

| `quarantine_reason` | Meaning |
| :--- | :--- |
| `UNKNOWN_DEVICE` | Not registered in Supabase |
| `MALFORMED_IDENTITY` | Wrong length or non-hex; the message names the likely cause |
| `IDENTITY_MISMATCH` | The topic and the `Asset_ID` metric disagree |
| `GATEWAY_MISMATCH` | Published by an edge node the device is not bound to |

Birth parameters and declared metrics are recorded **even for quarantined devices** — that is
exactly what an administrator needs to inspect before approving. Only DDATA telemetry is gated.

Approval goes through the [`approve-quarantine`](../supabase/functions/approve-quarantine) edge
function, which calls the atomic `public.approve_quarantined_device()` RPC.

---

## TimescaleDB Telemetry Mapping

| Sparkplug value | Column |
| :--- | :--- |
| `int_value`, `long_value`, `float_value`, `double_value` | `val_double` |
| `boolean_value` | `val_bool` |
| `string_value` | `val_string` |
| no value set | skipped |

`Asset_ID` and `Asset_Name` are excluded — they carry identity, not telemetry.

Rows are keyed by **`sparkplug_id`**, never by name, so a rename never breaks a series. The
`assets` dimension row is upserted on every write with the current display label.

### Two integrity rules

- **`ON CONFLICT … DO NOTHING`**, not `DO UPDATE`. The historian records what was observed; it is
  not a mutable store. An upsert let any publisher rewrite history at a timestamp of its choosing.
  A genuine duplicate is a redelivered MQTT message, and the first write already recorded it.
- **A sanity window on device-supplied timestamps** — `TELEMETRY_MAX_AGE_SECONDS` (24 h) and
  `TELEMETRY_MAX_FUTURE_SECONDS` (5 min). Deliberately asymmetric: late data is normal (a gateway
  buffers through an outage and flushes on reconnect), whereas data from the future is always a
  clock fault. Out-of-window metrics are **rejected, not clamped** — clamping would relabel a
  reading as having happened at a time it did not, and would pile every sample from a broken clock
  onto one timestamp where the primary key collapses them anyway.

---

## Configuration

Read from the environment. **There are no default credentials**: the daemon refuses to start
without `MQTT_PASSWORD`, and without `DB_PASSWORD` unless `TIMESCALEDB_URL` supplies its own. A
published default is a silent security downgrade, and the failure mode is silence.

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `MQTT_HOST` / `MQTT_PORT` | `mosquitto` / `1883` | Compose-internal name |
| `MQTT_USER` / `MQTT_PASSWORD` | `factoryplus` / **required** | |
| `DB_HOST` / `DB_PORT` | `timescaledb` / `5432` | Port defaults to `5433` when `DB_HOST` is unset, i.e. running from the host |
| `DB_PASSWORD` | **required** | Unless `TIMESCALEDB_URL` is set |
| `SUPABASE_URL` | `http://127.0.0.1:54321` | |
| `SUPABASE_SERVICE_ROLE_KEY` | **required** | Without it the daemon exits rather than running fail-open |

---

## Testing

### Unit tests (no stack required)

```bash
python ingestion/test_gateway_binding.py
python ingestion/test_declared_metrics.py
python ingestion/test_device_location.py
```

Each stubs `psycopg2`, `paho.mqtt` and the protobuf module before importing `ingestion.py`, so they
are pure-logic tests that need neither Docker nor `protoc`.

### End-to-end validation (stack required)

```bash
docker compose up -d
set -a && . ./.env && set +a && unset MQTT_HOST DB_HOST DB_PORT
python ingestion/validate.py
```

> **`validate.py` needs `SUPABASE_SERVICE_ROLE_KEY` but must NOT inherit the rest of `.env`.**
> Without the key it seeds nothing and fails ~12 of 20 checks in a way that reads like a schema
> fault, with the real cause one line up: `Service role key: MISSING`. But sourcing `.env` wholesale
> breaks it a second way — `MQTT_HOST=mosquitto` and `DB_HOST=timescaledb` are compose-internal
> names that do not resolve from the host, and the script's own defaults are the correct ones there.

It seeds a cell, gateway, devices and schemas, publishes real Sparkplug payloads, and asserts 20
outcomes covering quarantine, identity diagnostics, birth observation, multi-submodel conformance,
digital-thread triggers, telemetry mapping, rename safety and quarantine gating.

**Every assertion is scoped to the run's own entities.** The stack always has audit rows, telemetry
and devices from the demo simulator, so a check that queried a whole table and asserted "not empty"
would pass regardless of whether anything was exercised.

Its cleanup uses a **direct owner connection** to Supabase Postgres for audit rows, because
`public.digital_thread` is genuinely append-only — the trigger added in
[`0003`](../supabase/migrations/0003_audit_immutability_and_quarantine_rpc.sql) refuses `DELETE`
for `service_role` too. Clearing audit rows is meant to require owner authority.

---

## Related

- [`../supabase/README.md`](../supabase/README.md) — schema, RLS, triggers, edge functions
- [`../simulators/README.md`](../simulators/README.md) — Node-RED flow and broker topics
- [`../mosquitto.acl`](../mosquitto.acl) — per-gateway topic confinement
