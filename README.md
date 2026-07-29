# Factory+ Asset Tracking Platform (Supabase BaaS + Standalone TimescaleDB)

[![CI Pipeline](https://github.com/Harri-Llewelyn/acs-cymru/actions/workflows/ci.yml/badge.svg)](https://github.com/Harri-Llewelyn/acs-cymru/actions/workflows/ci.yml)

An industrial, asset-centric manufacturing management platform built in alignment with the **AMRC Connectivity Stack (ACS / Factory+)** framework.

This application provides real-time telemetry streaming, shopfloor spatial mapping, automated Zero-Touch Edge device onboarding, fine-grained Row-Level Security (RLS), continuous Digital Thread audit logging, and Edge flow management.

---

## System Architecture & Design Principles

The platform uses a decoupled architecture combining **Supabase Backend-as-a-Service (BaaS)** with **Standalone TimescaleDB**:

* **Supabase BaaS**: Manages asset metadata (`cells`, `gateways`, `devices`), Supabase Auth, Row-Level Security (RLS) policies, PostgreSQL triggers for automated `digital_thread` audit logging, and TypeScript Supabase Edge Functions.
* **Standalone TimescaleDB**: High-performance time-series database running `timescale/timescaledb:latest-pg15` exposed on port `5433` for `telemetry` hypertable metric storage (schema auto-provisioned via `timescaledb/init/`).
* **Python Ingestion Engine**: Consumes Sparkplug B industrial MQTT messages (`DBIRTH`, `DDATA`), verifying asset registration in Supabase (auto-quarantining unregistered devices) and streaming telemetry metrics directly to TimescaleDB.
* **React Web Dashboard**: React 18 SPA powered by Supabase JS SDK, utilizing direct PostgREST queries, real-time database change channels (`supabase.channel`), and Supabase Auth session management.

### Design Decision: Supabase Storage is Deliberately Not Deployed

This platform stores **no binary objects**, so `supabase-storage` (storage-api) and `imgproxy` are
intentionally omitted from `docker-compose.yml`. This is a deliberate design decision, not a gap.

Document management is a **link registry, not a file store**. The `documents` table holds a
`url TEXT` column pointing at an external system (SharePoint, Google Drive, or any HTTP(S) URL) —
there is no upload path anywhere in the UI, and no bucket is ever created.

> [!NOTE]
> **Supabase Studio's Storage page will therefore report an error** (`API error happened while trying
> to communicate with the server`) in this stack. This is expected and can be ignored — no
> application feature depends on it. If binary object storage is ever required, add the official
> `storage-api` and `imgproxy` services plus a `/storage/v1/` route in `supabase/kong.yml`.

For the same reason, the `storage` entry in `PGRST_DB_SCHEMAS` is vestigial. It is harmless and left
in place so the setting matches upstream Supabase defaults.

### System Topology Diagram

```mermaid
flowchart TB
    subgraph Edge Layer ["Edge & Physical Shopfloor Layer"]
        NR["Node-RED Edge Gateway<br/>(Port 1880)"]
        SIM["Sparkplug B Simulator<br/>(ingestion/validate.py)"]
    end

    subgraph Messaging ["Message Broker Layer"]
        MQTT["Mosquitto MQTT Broker<br/>(Ports 1883, 9001)"]
    end

    subgraph Processing ["Ingestion & Edge Functions"]
        ING["Python Ingestion Engine<br/>(ingestion/ingestion.py)"]
        EF["Supabase Edge Functions<br/>(approve-quarantine, deploy-nodered)"]
    end

    subgraph Supabase ["Supabase Backend-as-a-Service (Local Dev / Cloud)"]
        AUTH["Supabase Auth"]
        POSTGREST["Supabase PostgREST API<br/>- cells, gateways, devices<br/>- digital_thread audit log<br/>- Row Level Security (RLS)"]
        STUDIO["Supabase Studio Web UI<br/>(Port 8000 / 54323)"]
    end

    subgraph TelemetryDB ["Standalone TimescaleDB"]
        TSDB[("TimescaleDB PostgreSQL<br/>(Port 5433 / 5432)<br/>- Hypertable Telemetry")]
    end

    subgraph User Experience ["Presentation & Monitoring"]
        UI["React Web Dashboard<br/>(Port 3000)"]
        GRAF["Grafana Dashboards<br/>(Port 3002)"]
    end

    NR -->|Sparkplug B MQTT| MQTT
    SIM -->|Sparkplug B MQTT| MQTT
    MQTT -->|Subscribe spBv1.0/#| ING
    ING -->|Check / Quarantine| POSTGREST
    ING -->|Insert Telemetry Metrics| TSDB
    UI -->|Supabase Auth & PostgREST| POSTGREST
    UI -->|Invoke Edge Functions| EF
    STUDIO <-->|Manage Metadata & DB| POSTGREST
    GRAF -->|TimescaleDB Queries| TSDB
```

---

### Service Port Directory

Running `docker compose up -d` launches the entire unified application stack:

| Service | Container Name | Image / Build Target | Port | Description |
| :--- | :--- | :--- | :--- | :--- |
| **`supabase-db`** | `factoryplus_supabase_db` | `supabase/postgres:15.6.1.143` | `54322:5432` | Authoritative Supabase PostgreSQL BaaS engine |
| **`supabase-db-init`** | `factoryplus_supabase_db_init` | `supabase/postgres:15.6.1.143` | — | One-shot init container applying migrations and seeding `seed.sql` |
| **`supabase-auth`** | `factoryplus_supabase_auth` | `supabase/gotrue:v2.189.0` | — | GoTrue Auth server (connects via least-privilege `supabase_auth_admin` role) |
| **`supabase-rest`** | `factoryplus_supabase_rest` | `postgrest/postgrest:v12.2.0` | — | PostgREST API engine (connects via least-privilege `authenticator` role) |
| **`supabase-kong`** | `factoryplus_supabase_kong` | `kong:2.8.1-alpine` | `54321:8000` | Kong API Gateway (`http://127.0.0.1:54321`) |
| **`supabase-functions`** | `factoryplus_supabase_functions` | `supabase/edge-runtime:v1.74.2` | — | Supabase Deno Edge Runtime executing serverless functions |
| **`supabase-meta`** | `factoryplus_supabase_meta` | `supabase/postgres-meta:v0.91.0` | — | Schema introspection API backing Supabase Studio's Database pages |
| **`supabase-studio`** | `factoryplus_supabase_studio` | `supabase/studio:latest` | `54323:3000` | Supabase Studio administrative Web UI (`http://127.0.0.1:54323`) |
| **`timescaledb`** | `factoryplus_timescaledb` | `timescale/timescaledb:latest-pg15` | `5433:5432` | Standalone TimescaleDB instance for `telemetry` hypertable (schema auto-provisioned via `timescaledb/init/`) |
| **`mosquitto-init`** | `factoryplus_mosquitto_init` | `eclipse-mosquitto:latest` | — | One-shot init container generating Mosquitto password file from environment variables |
| **`mosquitto`** | `factoryplus_mosquitto` | `eclipse-mosquitto:latest` | `1883:1883`, `9001:9001` | Eclipse Mosquitto MQTT broker for Sparkplug B traffic (credentials auto-generated via `mosquitto-init` from `.env`) |
| **`frontend`** | `factoryplus_frontend` | `./frontend/Dockerfile` | `3000:3000` | React Web Dashboard UI (served via NGINX static file server) |
| **`ingestion`** | `factoryplus_ingestion` | `./Dockerfile` | — | Python daemon routing metadata to Supabase & telemetry to TimescaleDB |
| **`node-red-init`** | `factoryplus_node_red_init` | `nodered/node-red:latest` | — | One-shot init container configuring Node-RED flows & credentials |
| **`node-red`** | `factoryplus_node_red` | `nodered/node-red:latest` | `1880:1880` | Edge flow automation runtime |
| **`grafana`** | `factoryplus_grafana` | `grafana/grafana:latest` | `3002:3000` | Analytics dashboards connected to TimescaleDB |
| **`swagger-ui`** | `factoryplus_swagger_ui` | `swaggerapi/swagger-ui:v5.17.14` | `8088:8080` | Interactive API reference (`http://localhost:8088`) |

---

## Sparkplug B Protocol Coverage

The ingestion engine (`ingestion/ingestion.py`) subscribes to `spBv1.0/#` and speaks real Sparkplug B —
`sparkplug_b.proto` is the full, unmodified Eclipse Tahu schema, and `parse_sparkplug_payload()` tries
binary protobuf decoding first. This platform is a **fleet-monitoring dashboard with one-way ingestion**
(device → MQTT → Supabase/TimescaleDB), not a SCADA/MES control system, so it deliberately uses only the
subset of the spec that serves that job. This section documents exactly where that line is drawn, so a
reader integrating a real device — or extending the platform — knows what to expect.

### Messages the platform acts on

`on_message()` (`ingestion/ingestion.py:412-457`) routes six message types to real behaviour:

| Message | Level | Handled by | Effect |
| :--- | :--- | :--- | :--- |
| `NBIRTH` | Node (gateway) | `process_node_message()` | Sets `gateways.status = ONLINE`, stamps `last_heartbeat` |
| `NDATA` | Node (gateway) | `process_node_message()` | Same as `NBIRTH` — refreshes `last_heartbeat` so the gateway isn't marked `STALE` (`frontend/src/utils/gatewayStatus.js`, 90s threshold) |
| `NDEATH` | Node (gateway) | `process_node_message()` | Sets `gateways.status = OFFLINE` |
| `DBIRTH` | Device | `process_dbirth()` | Auto-registers an unrecognized device as quarantined (`is_quarantined = true`); stores birth parameters into `asset_config`; stamps `devices.first_dbirth_at` once, on the real first birth |
| `DDATA` | Device | `process_ddata()` | Writes telemetry to the TimescaleDB `telemetry` hypertable — gated: dropped silently for quarantined/unregistered devices |
| `DDEATH` | Device | `process_ddeath()` | Sets `devices.status = OFFLINE` |

`NBIRTH` and `NDATA` are treated identically at the gateway level — there's no separate "define metrics"
step for the node birth. Both are recurring liveness pings as far as this platform is concerned; `NDEATH`
is the only node-level message that changes behaviour.

### Spec features defined in the schema but not used

`sparkplug_b.proto` carries the complete Tahu message definition, but ingestion only ever reads a
metric's `.name`, `.datatype`, and its scalar value field (`double_value` / `string_value` /
`boolean_value`). The following fields arrive on the wire (with a real protobuf-speaking device) and are
simply never read:

| Feature | Proto reference | Purpose in the spec | Status here |
| :--- | :--- | :--- | :--- |
| `seq` (payload sequence number) | `sparkplug_b.proto:223` | Detect dropped/out-of-order messages and trigger a rebirth | Set by every publisher (including `node_red_flow.json`), never checked for gaps |
| `metric.alias` | `sparkplug_b.proto:194` | Numeric shorthand for a metric name, established at birth, to shrink `DATA` payloads | Never used — every message always carries full metric names |
| `metric.is_historical` | `sparkplug_b.proto:197` | Flags backfilled/buffered data so it isn't mistaken for a live reading | Not read. Per-metric timestamps *are* honoured (`process_ddata` uses `metric.timestamp` when present), so backfilled data still lands at the correct time in TimescaleDB — it's just not distinguished from live data anywhere (e.g. no "backfilled" marker in the UI) |
| `metric.properties` / `metadata` | `sparkplug_b.proto:200-201` | Structured per-metric metadata (units, ranges, docs) | Not used — values like `max_temp_threshold` are plain sibling metrics, not properties attached to `temperature` |
| `DataSet` / `Template` | `sparkplug_b.proto:79,108` | Tabular / nested structured metric types (UDTs) | Not used anywhere — only flat scalar metrics appear |
| `bdSeq` | MQTT Last Will and Testament payload | Ties a node's `NDEATH` to its MQTT session so an ungraceful disconnect is caught immediately | Not used. The JSON fallback parser (see below) doesn't even support `long_value`, so it couldn't carry `bdSeq` without a code change |

> [!NOTE]
> The simulator (`node_red_flow.json`) publishes JSON, not binary protobuf. `parse_sparkplug_payload()`
> (`ingestion/ingestion.py:375-409`) falls back to decoding that JSON into the same `Payload`/`Metric`
> objects when protobuf parsing fails, so the simulator's messages are handled identically to a real
> device's once parsed — see `node_red_guide.md` for the full simulator walkthrough.

### Message types the platform never listens for

- **`NCMD` / `DCMD`** (Node/Device Command) — the spec's Host→Edge control channel for pushing commands
  or a "Rebirth" request down to a device. This platform is strictly one-directional; nothing ever
  publishes to a device. A node-level `NCMD` is silently dropped (no `Asset_ID` to resolve, hits the
  early return at `ingestion/ingestion.py:447-448`); a device-level `DCMD` is logged and discarded (the
  `else` branch at `ingestion/ingestion.py:456-457`).
- **`STATE`** (`spBv1.0/STATE/{host_id}`) — the retained topic a Sparkplug "Primary Host Application"
  publishes to announce itself online/offline. The topic is only 3 segments, so it's dropped before
  message-type dispatch even runs (`len(parts) < 4` at `ingestion/ingestion.py:414-415`). This platform
  never announces itself as a primary host.

### Why this is scoped this way

Aliasing, Templates/DataSets, and the command channel all solve problems (bandwidth at scale, structured
complex payloads, two-way control) that a fleet-monitoring dashboard doesn't need. The one gap worth
calling out as a genuine improvement rather than an intentional scope boundary is **`seq` gap detection**:
it's cheap to add and directly improves data integrity (which this platform already cares about — see
fail-closed quarantine gating and the `digital_thread` audit trail) by letting the ingestion engine notice
a dropped message and log/alert on it, rather than silently continuing.

---

## Authentication & Role-Based Access Control (RBAC)

Supabase Auth is the authoritative identity provider for the application. User privileges are determined strictly by server-side role claims stored in `app_metadata.role`:

| Persona / Email | Role Claim | Access Scope |
| :--- | :--- | :--- |
| `admin@factoryplus.local` | `Administrator` | Full read/write access to cells, gateways, devices, and quarantine approvals. |
| `manager@factoryplus.local` | `Shopfloor_Manager` | Operations management, device quarantine approvals, and Node-RED deployments. |
| `operator@factoryplus.local` | `Operator` | Read-only view of shopfloor assets and telemetry. |
| `auditor@factoryplus.local` | `Auditor` | Digital Thread audit trace view. |

> [!IMPORTANT]
> Edge Functions and RLS policies enforce **fail-closed** authorization. Any token missing a valid role claim or containing an unprivileged role (e.g. `Operator`) will receive `403 Forbidden` on administrative mutations such as device quarantine approval.

---

## Database Migrations & Row Level Security (RLS)

All database migrations are stored in `supabase/migrations/`:
- **`20260101000000_init_assets_and_digital_thread.sql`**:
  - **Tables**: `cells`, `gateways`, `devices`, `digital_thread`.
  - **Triggers**: PL/pgSQL function `log_digital_thread_event()` automatically logs audit events on `cells`, `gateways`, and `devices` mutations.
  - **RLS Policies**: Enforces `SELECT` permissions for `authenticated` users, and `INSERT`/`UPDATE`/`DELETE` for `Administrator` and `Shopfloor_Manager` roles.
- **`20260101000002_add_documents_and_config.sql`**:
  - **Tables**: `documents`, `asset_config`, `schemas`, `directory_services`.
  - **RLS Policies**: Enforces RLS permissions for entity document links, asset parameter configurations, schema registry definitions, and directory services.
- **`20260101000003_add_rbac_permissions.sql`**:
  - **Tables**: `roles`, `permissions`, `role_permissions`, `user_roles`.
  - **Permissions System**: Defines role definitions and fine-grained permission UUIDs (including `digital_thread:read`). Drives frontend UI permission gating (`usePermissions.js`), with distinct permission assignments for `Operator` (`telemetry:read`, `quarantine:view`) and `Auditor` (`digital_thread:read`).
- **`20260101000004_fix_user_roles_rls.sql`**:
  - **RLS Policy Fix**: Replaces overly-broad `user_roles` SELECT policy with `user_roles_select_own_or_privileged`, restricting visibility of `user_roles` records strictly to the record owner (`auth.uid()`) or administrative roles (`Administrator` / `Shopfloor_Manager`).
- **`20260101000005_restrict_digital_thread_access.sql`**:
  - **RLS Policy Restriction**: Replaces permissive `digital_thread_select_authenticated` policy with `digital_thread_select_privileged_or_auditor`, restricting `digital_thread` SELECT access strictly to `Administrator`, `Shopfloor_Manager`, and `Auditor` roles.
- **`20260101000006_immutable_digital_thread.sql`**:
  - **Append-Only Audit Log**: Revokes `INSERT`/`UPDATE`/`DELETE` on `digital_thread` from `authenticated`, so audit rows can only ever be written by the `SECURITY DEFINER` trigger.
- **`20260101000007_rls_has_role_function.sql`**:
  - **Centralised Role Checks**: Introduces `public.has_role(text[])`, backed by `user_roles` rather than raw JWT claims, and rewrites every privileged RLS policy to use it.
  - **JWT Claim Sync**: Adds `public.custom_access_token_hook()` so `app_metadata.role` is refreshed from the database on every token issue/refresh.
- **`20260101000008_handle_new_user.sql`**:
  - **Default Role for Self-Registration**: `AFTER INSERT` trigger on `auth.users` granting new sign-ups the read-only `Operator` role (both a `user_roles` row and `raw_app_meta_data.role`). Seeded personas are left untouched.
- **`20260101000009_gateway_heartbeat_and_service_directory.sql`**:
  - **Gateway Heartbeats**: Adds `gateways.last_heartbeat` (plus `ip_address` and `is_virtual`), written by the ingestion daemon on every Sparkplug B node-level message.
  - **DBIRTH Parameters**: `asset_config` is populated by the ingestion daemon on every `DBIRTH`, upserted per `(asset_id, metric_name)` and keyed by the Sparkplug B device name. This is what the Devices page's **Config** button displays — firmware version, serial number, thresholds and interlocks announced in the birth certificate. Recorded for quarantined devices too, so an administrator can inspect what a newly discovered device claims before approving it (DDATA telemetry stays gated).
  - **Device Classification**: Adds `devices.asset_type` and `devices.connection_method`, which the device form has always collected but had nowhere to store.
  - **Edge Node Registration**: Registers the `Virtual_Gateway_NodeRED` edge node published by `node_red_flow.json`, so heartbeats have a matching gateway row on a fresh stack.
  - **Service Directory**: Completes `directory_services` with every stack service — Supabase Studio, Kong, Auth, PostgREST, Edge Functions, Supabase PostgreSQL, TimescaleDB, and the ingestion engine.
- **`20260101000010_telemetry_foreign_table.sql`**:
  - **Telemetry over PostgREST**: Creates a `postgres_fdw` link to the standalone TimescaleDB and exposes the hypertable as the read-only `public.telemetry` view, granted to `authenticated` only (`anon` gets `401`). This is how the dashboard reads real time-series data — TimescaleDB itself is not reachable from the browser.
  - **`security_invoker = true`**: the view runs with the querying role's own privileges rather than the view owner's (`postgres`), avoiding Supabase Advisor's Security Definer View finding. A `FOR PUBLIC` user mapping plus `GRANT`s on the underlying foreign table give `authenticated`/`service_role` their own path through the FDW — every authenticated user still sees the same unfiltered telemetry as before, only whose privileges enforce the read has changed.
  - Connection settings arrive as `psql -v` variables from `supabase-db-init`; the defaults match `docker-compose.yml`, so the file is still runnable standalone.
- **`20260101000011_advisor_hardening.sql`**:
  - **Closes remaining Supabase Advisor findings**: revokes `anon`'s residual `SELECT` on every RBAC table — an unused grant surviving Supabase's cluster-init defaults, not something any migration had explicitly requested. RLS already returned zero rows to `anon` on all of them, so this only closes `pg_graphql` schema-introspection exposure, not an actual data leak.
  - **Locks down `SECURITY DEFINER` functions**: revokes `EXECUTE` from roles that never legitimately call them directly — `custom_access_token_hook`, `handle_new_user`, and `log_digital_thread_event` from `anon`/`authenticated` entirely (trigger/auth-hook-only functions), and `has_role` from `anon` only (`authenticated` keeps it, since RLS policies invoke it from their own `USING`/`WITH CHECK` clauses).
- **`20260101000012_device_provisioning_tracking.sql`**:
  - **Provisioning tracking**: Adds `devices.first_dbirth_at`, written exactly once by the ingestion daemon on a device's real first `DBIRTH`. Distinguishes "provisioned but never seen" from "was online, then went offline" — both previously looked identical (`status = 'OFFLINE'`). The Devices tab flags a device **AWAITING FIRST BIRTH** once more than 24h have passed since provisioning with no birth received (computed client-side, same pattern as gateway heartbeat staleness — see `frontend/src/utils/deviceProvisioning.js`).
  - **Schema linkage**: Adds `devices.schema_id`, optionally linking a device to a `schemas` row.
  - **Quarantine suggested-match**: when an unrecognized device lands in quarantine, it's compared against every provisioned-but-never-seen device by name similarity, and — if a candidate has a schema assigned — by overlap between the schema's required metrics and what the quarantined device actually reported. A match surfaces as a "did you mean...?" suggestion in the approval modal; accepting it re-keys the quarantined device's `asset_config` history onto the provisioned device, absorbs its status, and discards the quarantined row, rather than treating a typo'd device name as a brand new device (see `approve-quarantine` below).
- **`20260101000013_metric_catalog.sql`**:
  - **Metric catalog**: A registry of individually-defined Sparkplug B metrics (name, Sparkplug datatype, description) that schemas are built from via the Schemas tab's **Build Schema from Catalog** flow — pick metrics, then either download a JSON spec sheet (the metric list plus the exact topic string an integrator's device should publish to) or provision a device with the resulting schema already attached.
  - **Append-only by design**: a metric's `name`/`datatype` are immutable once created, enforced by a `BEFORE UPDATE` trigger (not just the UI) — a physical device is already configured to publish under that exact name, so "editing" a metric means deprecating it and adding a new catalog entry, never rewriting one in place. Mirrors `digital_thread`'s append-only philosophy.

### Asset Relationship Model

`cells → gateways → devices` is a strict chain. **Devices have no `cell_id`**: a device belongs to
the cell that its edge gateway is assigned to. The dashboard reads this with nested PostgREST
embeds (`cells?select=*,gateways(...,devices(...))`), and the Gateways page is where a gateway is
attached to a cell. A gateway with no cell — or a device with no gateway — is flagged in the UI
rather than silently disappearing from the Cells and Overview pages.

> [!NOTE]
> All migrations are idempotent and are re-applied by `supabase-db-init` on every stack start. `supabase-db-init` runs with `set -e` and `psql -v ON_ERROR_STOP=1`, so a failing migration aborts startup loudly instead of being silently skipped.

---

## Supabase Edge Functions

Edge functions are located in `supabase/functions/`. Requests arrive at Kong on `/functions/v1/<name>`
and are dispatched by the **main service router** (`supabase/functions/main/index.ts`), which spawns
each function as an isolated user worker via `EdgeRuntime.userWorkers.create()`.

> [!IMPORTANT]
> Because every function runs in its own isolate, each one **must** keep its own `serve(handler)`
> entry point — that is required by the runtime, not redundant. Functions are *not* loaded by
> in-process `import()`; attempting to do so fails and yields an opaque
> `Edge Function returned a non-2xx status code` in the browser.

- **`approve-quarantine`** (`supabase/functions/approve-quarantine/index.ts`):
  - Validates session JWT & role claims (`Administrator` / `Shopfloor_Manager`).
  - Fails closed (`403 Forbidden`) if role claim is missing or unprivileged.
  - Sets `is_quarantined = false` and assigns `gateway_id` for approved devices via Supabase Service Role client.
  - **Suggested-match merge**: an optional `merge_into_device_id` in the request body switches to a different path — instead of un-quarantining the submitted device, it re-keys the quarantined device's `asset_config` rows onto the target provisioned device, absorbs its status/`first_dbirth_at`, and deletes the quarantined row. Driven by the Devices tab's quarantine "did you mean...?" suggestion (see `20260101000012_device_provisioning_tracking.sql` above).
- **`deploy-nodered`** (`supabase/functions/deploy-nodered/index.ts`):
  - Validates session JWT & role claims (`Administrator` / `Shopfloor_Manager`).
  - Fails closed (`401 Unauthorized` / `403 Forbidden`) if Authorization header or role claim is missing or unprivileged.
  - Deploys flows to Node-RED (`http://node-red:1880/flows`) and returns `{ status: "DEPLOYED", nodes_deployed, source }`.
  - **GitOps contract**: the repository is the source of truth. A request body of `{ "commit_message": "..." }` (what the Directory tab sends) deploys the canonical `node_red_flow.json` committed to this repo. Passing a Node-RED flow **array** instead deploys that payload verbatim.
  - The flow reaches the function via the `NODERED_FLOW_JSON` environment variable, populated from `node_red_flow.json` by the `supabase-functions` entrypoint. An edge-runtime **user worker has no filesystem access to the mounted volumes**, and module-relative paths resolve into an ephemeral compile directory rather than the mount — so the flow is passed through the environment, which `main/index.ts` forwards to every worker it spawns.
  - `NODERED_ADMIN_TOKEN` is optional: an `Authorization` header is sent only when it is set, so deployment works against a Node-RED instance without `adminAuth`.

---

## API Reference (Swagger UI)

The platform's HTTP surface is documented as OpenAPI 3 in [`docs/openapi.yaml`](docs/openapi.yaml)
and served interactively by the `swagger-ui` container at **`http://localhost:8088`**.

Two specs are available from the dropdown:

| Spec | Source | Use it for |
| :--- | :--- | :--- |
| **Factory+ Platform API** | `docs/openapi.yaml` (curated) | Hand-written reference with worked examples, the asset relationship model, RLS behaviour, and the Edge Functions. |
| **PostgREST (live database schema)** | Generated by PostgREST at runtime | The exhaustive, always-current list of every table, column and filter operator. |

Everything routes through Kong on `http://127.0.0.1:54321`:

| Prefix | Upstream | Purpose |
| :--- | :--- | :--- |
| `/auth/v1/` | Supabase Auth (GoTrue) | Sign in, sign up, session refresh |
| `/rest/v1/` | PostgREST | Asset metadata, telemetry, audit log |
| `/functions/v1/` | Supabase Edge Runtime | `approve-quarantine`, `deploy-nodered` |

### Trying a request

Every request needs **both** an `apikey` header (the anon key from `.env`) and an
`Authorization: Bearer <token>` header. Get a token first:

```bash
curl -X POST "http://127.0.0.1:54321/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
  -d '{"email":"admin@factoryplus.local","password":"factoryplus123"}'
```

Paste the `access_token` into Swagger UI's **Authorize** dialog and "Try it out" works against
the running stack — `supabase/kong.yml` allows the Swagger UI origin through CORS.

> [!NOTE]
> Changing `SWAGGER_PORT` in `.env` also requires adding the new origin to the `cors` plugin
> in [`supabase/kong.yml`](supabase/kong.yml), otherwise in-browser requests are blocked.

---

## Continuous Integration (CI Pipeline)

The GitHub Actions CI workflow ([`.github/workflows/ci.yml`](file:///.github/workflows/ci.yml)) executes automated testing and verification across three parallel jobs:

1. **`frontend-build` (Frontend Build & Test)**: Installs Node.js dependencies, runs the Vitest unit test suite (`npm test`), and builds the Vite production bundle (`npm run build`).
2. **`edge-function-auth-test` (Edge Function Authorization Unit Tests)**: Runs unit tests (`test_approve_quarantine.py`, `test_deploy_nodered.py`, `test_user_roles_rls.py`) to verify fail-closed role authorization for missing claims and non-privileged roles.
3. **`e2e-validation` (End-to-End Ingestion Validation)**: Installs Python dependencies, installs `protobuf-compiler`, compiles `sparkplug_b.proto` via `protoc --python_out=. sparkplug_b.proto`, launches the unified Docker Compose stack (`docker compose up -d`), polls service health, and executes `python ingestion/validate.py`.

---

## End-to-End Validation

Running `ingestion/validate.py` outside of Docker requires `protobuf-compiler` (`protoc`) installed on your host system to compile the Sparkplug B protobuf definition:

```bash
# 1. Compile Sparkplug B Protobuf module (prerequisite outside Docker)
protoc --python_out=. sparkplug_b.proto
cp sparkplug_b_pb2.py ingestion/

# 2. Execute the end-to-end integration test suite
python ingestion/validate.py
```

> [!NOTE]
> When running the stack in Docker (`docker compose up --build -d`), `sparkplug_b_pb2.py` is compiled automatically inside the container build step.

The validation script verifies:
1. **MQTT Payload Publishing**: Sends Sparkplug B `DBIRTH` and `DDATA` messages to Mosquitto.
2. **Supabase Device Quarantine**: Confirms unknown device `DBIRTH` announcements auto-insert into Supabase `devices` with `is_quarantined = true`.
3. **Digital Thread Audit Triggers**: Confirms PostgreSQL triggers automatically populate `digital_thread`.
4. **TimescaleDB Telemetry**: Confirms metric ingestion for registered devices into the TimescaleDB `telemetry` hypertable.
5. **Quarantine Telemetry Gating**: Confirms telemetry (`DDATA`) published by quarantined or unregistered devices is gated and dropped, ensuring zero records reach TimescaleDB until approved.

---

## Known Issues

Open issues identified during development but **not** yet fixed. Recorded here so they are not
lost. Each entry names the offending code so it can be picked up directly.

### Functional gaps

| # | Issue | Location | Impact |
| :-- | :--- | :--- | :--- |
| 1 | **Real-time subscriptions are disabled.** No `realtime` service is deployed and `kong.yml` has no `/realtime/v1/` route, so `postgres_changes` can never fire. The subscription is now behind `VITE_ENABLE_REALTIME` (default off) rather than opening a WebSocket that fails and retries forever. | [`frontend/src/App.jsx`](frontend/src/App.jsx) | Every tab refreshes on a 3s `usePolling` cycle. Set `VITE_ENABLE_REALTIME=true` once a realtime service is actually deployed. |
| 2 | **GitOps status is hardcoded stub data.** `gitops_status`, `active_commit_sha` and `repository_url` are literals, not real values. | [`frontend/src/api.js`](frontend/src/api.js) | The Directory tab banner always shows `SYNCED` / commit `a8f3e4b` regardless of actual state. |
| 3 | **Node-RED editor changes are discarded on restart.** `node-red-init` copies `node_red_flow.json` over `/data/flows.json` on every `docker compose up`. | [`docker-compose.yml`](docker-compose.yml) (`node-red-init`) | Flows edited at `localhost:1880` are lost on the next stack restart. Edit `node_red_flow.json` in the repo instead — it is the source of truth (see `deploy-nodered`). |
| 4 | **`LIMIT` is not pushed down to TimescaleDB.** `postgres_fdw` pushes `WHERE` clauses to the remote but never `LIMIT`, so a telemetry query without a time filter materialises the whole matching range in Supabase before trimming. | [`supabase/migrations/20260101000010_telemetry_foreign_table.sql`](supabase/migrations/20260101000010_telemetry_foreign_table.sql) | Fine at demo volumes. At scale, narrow the time window or replace the view with a `dblink`-based RPC that builds the remote `LIMIT`. |
| 5 | **Device `asset_type` / `connection_method` are free text.** They are stored but not validated against the schema registry. | [`supabase/migrations/20260101000009_gateway_heartbeat_and_service_directory.sql`](supabase/migrations/20260101000009_gateway_heartbeat_and_service_directory.sql) | Cosmetic; no feature depends on their values. |

### Security / hardening

| # | Issue | Location | Impact |
| :-- | :--- | :--- | :--- |
| 6 | **Kong does not validate the `apikey` header.** There is no `key-auth` plugin and no consumers, unlike the stock Supabase gateway config. | [`supabase/kong.yml`](supabase/kong.yml) | Authorisation is enforced only downstream by PostgREST JWT verification and RLS. Acceptable for local dev; **must be addressed before any non-local deployment.** |
| 7 | **`.env.example` contains working development secrets** (`SUPABASE_JWT_SECRET`, the demo anon/service-role JWTs, `MQTT_PASSWORD`) and is committed to the repository. | [`.env.example`](.env.example) | These are the standard Supabase demo values and are safe for local use only. **Generate fresh secrets for any shared or hosted environment.** |
| 8 | **Node-RED admin API is unauthenticated.** The generated `settings.js` sets only `credentialSecret`; no `adminAuth` is configured, so `http://localhost:1880` and its `/flows` API are open. | `scripts/node-red-init.mjs` | Anyone with network access to port 1880 can read or replace edge flows. `deploy-nodered` sends an `Authorization` header only when `NODERED_ADMIN_TOKEN` is set, so enabling `adminAuth` is a config-only change. |

### Expected behaviour (not defects)

- **`docker compose down -v` invalidates every logged-in browser.** The `-v` flag drops
  `supabase_db_data`, and with it `auth.sessions`. A browser still holding a token keeps
  reading data — PostgREST verifies only the JWT signature — but Edge Functions validate
  the session with GoTrue and answer `401 Invalid user token: Session from session_id
  claim in JWT does not exist`. The dashboard now detects this on load (it validates the
  restored session with `auth.getUser()`), clears the stale tokens and returns to the
  login screen with an explanatory notice. Just sign in again.
- **Swagger UI's "Example Value" is documentation, not data.** The samples rendered from
  `docs/openapi.yaml` (`Assembly Line 1`, `Simulated_CNC_01`, ...) appear whether or not
  those records exist. Press **Execute** and read the **Response body** panel for real data.

- **Supabase Studio's Storage page reports an error.** Storage is deliberately not deployed — see
  [Design Decision: Supabase Storage is Deliberately Not Deployed](#design-decision-supabase-storage-is-deliberately-not-deployed).
- **`PGRST_DB_SCHEMAS` still lists `storage`.** Vestigial while no storage-api runs; kept to match
  upstream Supabase defaults.
- **Simulated devices appear quarantined on first start.** `Simulated_CNC_01` is auto-registered with
  `is_quarantined = true` by design; an `Administrator` must approve it before telemetry is stored.

---

## Quick Start & Installation Guide

1. **Environment Setup (Cross-Platform)**:
   ```bash
   npm run setup
   ```
   > [!NOTE]
   > `npm run setup` initializes `.env` from `.env.example` using plain Node.js (`scripts/setup.mjs`). This operates identically across Windows (PowerShell/CMD), macOS, and Linux without requiring POSIX shell commands (`eval` / `sed`).

2. **Start Full Unified Application Stack (Docker Compose)**:
   ```bash
   docker compose up --build -d
   ```
   > [!NOTE]
   > All services — including the Supabase BaaS stack, TimescaleDB, MQTT broker, and web UI — launch automatically. Database migrations (`supabase/migrations/`) and seeds (`supabase/seed.sql`) are applied on initial container startup by `supabase-db-init`.

3. **Access Web Interfaces**:
   - **React Dashboard & Management Console**: `http://localhost:3000`
   - **Supabase Studio**: `http://127.0.0.1:54323`
   - **API Reference (Swagger UI)**: `http://localhost:8088`
   - **Node-RED Console**: `http://localhost:1880`
   - **Grafana Dashboards**: `http://localhost:3002`

4. **Authentication Credentials**:
   - **Default Sign In**: The login screen (`http://localhost:3000`) is pre-filled with the local admin seed persona:
     - **Email**: `admin@factoryplus.local`
     - **Password**: `factoryplus123`
   - **Local Dev Seed Accounts**: Demo accounts (`admin@factoryplus.local`, `manager@factoryplus.local`, `operator@factoryplus.local`, `auditor@factoryplus.local` with password `factoryplus123`) are populated automatically during database initialization via `supabase/seed.sql` for local development.
   - **Self-Registration**: Click **"Need an account? Sign Up"** on the Portal to create a new user account instantly. Self-registered accounts are assigned the read-only **`Operator`** role by default (via the `handle_new_user` trigger in `supabase/migrations/20260101000008_handle_new_user.sql`); an `Administrator` must promote them to a privileged role.

7. **Repository Hand-off & Packaging Best Practices**:
   Before packaging or committing clean hand-offs, tear down volumes and ensure no untracked build artifacts remain:
   ```bash
   docker compose down -v
   git status
   ```
   Confirm `git status` displays a clean workspace with no untracked `node_modules`, `.env`, `dist`, or `coverage` folders.
