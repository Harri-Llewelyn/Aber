# Ingestion Engine

The Python daemon that consumes Sparkplug B traffic from Mosquitto and routes it to two different
stores: **asset metadata to Supabase**, **time-series telemetry to TimescaleDB**.

It is the only component that writes telemetry, and the only one that decides whether a device is
allowed to be heard at all.

| File | Purpose |
| :--- | :--- |
| [`ingestion.py`](ingestion.py) | The daemon. Identity resolution, quarantine gating, telemetry mapping |
| [`validate.py`](validate.py) | End-to-end validator — publishes real Sparkplug payloads and asserts 41 outcomes |
| [`logging_config.py`](logging_config.py) | Structured logger used by both |
| [`test_gateway_binding.py`](test_gateway_binding.py) | Gateway↔device binding, telemetry sanity window, append-only historian |
| [`test_declared_metrics.py`](test_declared_metrics.py) | Birth-metric observation, change-only writes, alias resolution, rebirth rate limit, device watchdog |
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

## Metric Aliases

Sparkplug binds each metric name to an **integer alias** in a birth certificate, and thereafter
publishes DATA carrying the alias alone with no name. That is the normal production configuration
for a real gateway — including upstream ACS's `acs-edge`.

Until this was implemented the daemon read only `metric.name`, so an alias-optimised gateway
**ingested zero metrics and logged nothing**. It was a total, silent data-loss path for any
standards-compliant device.

- **The table is keyed by `(group_id, edge_node_id)`, not by device.** Sparkplug scopes alias
  uniqueness to the whole edge node *including its devices*, so a device's DDATA may legitimately
  carry an alias that only the gateway's NBIRTH declared. A per-device table resolves the common
  case perfectly and fails only on gateways that declare shared metrics once — silently, and on
  the more sophisticated half of a fleet.
- **The Sparkplug Group ID is read from the topic but goes no further.** It scopes this table and
  addresses a rebirth back at the right node. Gateway and device resolution still ignore it and no
  column stores it — making the group part of an asset's identity is a schema change and belongs
  with that work.
- **NBIRTH resets the node's whole table; DBIRTH merges.** An NBIRTH invalidates every prior
  binding for the node and its devices, so a gateway that renumbers its aliases must not leave the
  old ones behind to be matched — that would write real samples under the *wrong* metric name,
  which is worse than dropping them. A DBIRTH re-declares one device and must not discard its
  siblings'.
- **Aliases are registered before the registration check**, in both handlers. The table is
  in-memory and costs nothing, and a quarantined device's later DDATA still has to be *decodable*
  for an operator to be told what it is publishing.
- **Resolution happens before the identity-metric filter.** An empty name never matches
  `Asset_ID`, so an aliased identity metric would otherwise be written to the historian as
  telemetry.
- **An unresolvable metric is skipped, never written under an empty name.** A nameless row is a
  corruption no query could find again. The rest of the message still ingests — in the cold-start
  case that matters, every metric is alias-only anyway, so the two behaviours coincide.
- The table is capped (`MAX_ALIASES_PER_NODE`) because it is fed by whatever the broker delivers.
  The cap counts *additions*, so a full table can still be re-pointed by a rebirth.

## Rebirth Requests (NCMD)

The alias table is in memory, so **it is empty after every restart** — and a stable device may not
birth again for weeks. Without a way to ask, an ingestion restart would silently stop recording
every alias-optimised device on the plant until someone power-cycled its gateway.

On an unresolvable alias the daemon publishes `Node Control/Rebirth` to
`spBv1.0/<group>/NCMD/<edge_node>`.

- **Rate limited per edge node** (`REBIRTH_REQUEST_INTERVAL_SECONDS`, default 300s). This is the
  load-bearing half: a gateway that answers a rebirth by restarting, or one that never answers at
  all, would otherwise be asked once per message and held in a reboot loop by the mechanism meant
  to recover it.
- **A failed publish still consumes the budget.** A broker refusing this publish will refuse the
  next one too, and retrying per message is exactly the flood the limit exists to prevent.
- The daemon ignores `NCMD`/`DCMD` on its own wildcard subscription, so its own request coming
  straight back is not read as edge-node traffic.
- `mosquitto.acl` already permits this: the `factoryplus` principal holds `readwrite spBv1.0/#`,
  and each gateway's `spBv1.0/+/+/%u/#` covers its own NCMD topic.
- **The demo Node-RED simulator does not answer a rebirth** — it publishes on a timer and
  subscribes to no command topic. That is a simulator limitation, not a daemon one.

## Device Liveness Watchdog

A device that stops publishing writes nothing and emits no DDEATH, so before this it stayed
**ONLINE forever**. A background thread flips devices OFFLINE after
`DEVICE_OFFLINE_TIMEOUT_SECONDS` of silence.

**Why this is a writer when gateway staleness deliberately is not.** `gateways.last_heartbeat` is
stamped on every heartbeat, so staleness is derivable at read time and `public.gateway_status` is
strictly better than a cron writer — migration 0024's header sets out why. A device has **no
last-seen column** to derive from, and adding one would mean an UPDATE per DDATA message, which is
an audit row per message. So the transition itself is what gets written, and only the transition.

Three properties keep it from becoming an audit-row generator or a false-alarm generator:

- **Only devices seen in *this process* are candidates.** An empty map after a restart is an
  absence of evidence, not evidence of absence. Seeding it from the database would mark a whole
  fleet OFFLINE on every restart — one `digital_thread` row each, in an append-only table — which
  is a far worse failure than the stale ONLINE this fixes.
- **The UPDATE carries `status = ONLINE` as a filter**, so an already-OFFLINE row matches nothing,
  no UPDATE runs, and `log_digital_thread_event()` never fires. That is a database-side guarantee,
  not a client-side intention.
- **A swept device is dropped from tracking**, so it is written once per quiet period rather than
  once per 30s tick. A failed write keeps it tracked, so the next sweep retries rather than
  silently concluding it was handled.

DDEATH removes the device from tracking outright — an explicit death certificate is the
authoritative answer and needs no second opinion.

> **Tuning.** Too *low* a value reports a healthy machine offline, which is the more misleading of
> the two failures. Raise the window for event-driven devices that legitimately stay quiet, or set
> `0` to disable.

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
| `DEVICE_OFFLINE_TIMEOUT_SECONDS` | `300` | Silence after which a device is marked OFFLINE. `0` disables the watchdog |
| `DEVICE_WATCHDOG_INTERVAL_SECONDS` | `30` | Sweep interval |
| `REBIRTH_REQUEST_INTERVAL_SECONDS` | `300` | Minimum gap between rebirth requests to one edge node |
| `MAX_ALIASES_PER_NODE` | `5000` | Cap on the per-node alias table |

The first three must match between `docker-compose.yml` and the chart's `ingestion.*` values —
`validate.py`'s watchdog check reads them from its own environment to decide whether the window is
short enough to wait for, and it runs against both targets.

---

## Testing

### Unit tests (no stack required)

```bash
python ingestion/test_gateway_binding.py
python ingestion/test_declared_metrics.py
python ingestion/test_device_location.py
python ingestion/test_health_heartbeat.py
```

Each stubs `psycopg2`, `paho.mqtt` and the protobuf module before importing `ingestion.py`, so they
are pure-logic tests that need neither Docker nor `protoc`.

### End-to-end validation (stack required)

Two ways to run it, and **in-cluster is the simpler of the two** — which is the opposite of what one
would expect.

**From the host, against Docker Compose:**

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

**In-cluster, as a Job in the namespace:**

```bash
helm upgrade factoryplus deploy/helm/factoryplus -n factoryplus \
  -f deploy/helm/factoryplus/values-dev.yaml --set e2e.enabled=true
kubectl -n factoryplus logs -f job/factoryplus-e2e-validate
```

**No host or port overrides at all.** Kubernetes Service names are kept identical to the Compose
service names, so `timescaledb`, `mosquitto` and `supabase-kong` *are* the correct configuration —
there is nothing to rewrite and nothing to port-forward. The Job's environment states the topology
explicitly all the same, so it reads as a complete description rather than relying on defaults.

Two port defaults are conditional on their host being set, and that is what makes both paths work
from one file: `DB_PORT` defaults to `5433` only when `DB_HOST` is unset (the published Compose port),
and `SUPABASE_DB_PORT` to `54322` likewise. Naming a host selects the standard `5432`. The banner
printed at startup lists every resolved endpoint, because **both ways of misconfiguring this script
fail somewhere other than at the cause** — from the host, compose-internal names give "Temporary
failure in name resolution"; in-cluster, a default host sends the script to its own pod's localhost.

### Liveness heartbeat

`INGESTION_HEALTH_FILE` (unset by default, which is a no-op) makes the daemon touch that file every
`INGESTION_HEALTH_INTERVAL` seconds **while its MQTT connection is up**. The Kubernetes liveness probe
reads nothing but the file's age.

This exists for the one failure Compose cannot detect at all: paho's network loop dies, the process
stays alive, and the daemon silently stops ingesting — nothing crashes, nothing logs, telemetry just
stops arriving. Gating the write on `client.is_connected()` is what makes the signal mean "my broker
connection is alive" rather than "my process exists"; a message counter would instead report the
daemon dead every time the shopfloor was quiet.

The write is deliberately forgiving of IO errors: a read-only or full filesystem should stop the
heartbeat — which correctly reports unhealthy — rather than crash a daemon that is otherwise fine.
`test_health_heartbeat.py` pins all of that, including the disconnected case.

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
