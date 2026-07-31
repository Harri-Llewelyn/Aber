# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

Factory+ Asset Tracking Platform is an industrial manufacturing management system built on the **Supabase BaaS** stack with a **standalone TimescaleDB** for time-series telemetry.

### Key Components

| Layer | Service | Port | Purpose |
|-------|---------|------|---------|
| **Web UI** | React SPA (NGINX) | 3000 | Dashboard with tabbed views |
| **API Gateway** | Kong | 54321 | Routes to PostgREST/Auth |
| **Auth** | Supabase GoTrue | - | JWT-based authentication |
| **Database** | Supabase PostgreSQL | 54322 | Asset metadata, RLS, triggers |
| **TimescaleDB** | PostgreSQL + Timescale | 5433 | Telemetry hypertable storage |
| **MQTT** | Mosquitto | 1883/9001 | Sparkplug B message broker |
| **Ingestion** | Python daemon | - | MQTT→Supabase/TimescaleDB |
| **Realtime** | Supabase Realtime | - | WAL → WebSocket change feed via `/realtime/v1/` |
| **Edge** | Node-RED | 1880 | Edge flow automation |
| **Monitoring** | Grafana | 3002 | Time-series dashboards (SSO via Supabase Auth) |

### Data Flow

1. **Sparkplug B devices** publish `DBIRTH` (birth) and `DDATA` (data) messages to Mosquitto
2. **Python ingestion engine** consumes `spBv1.0/#` topic:
   - Resolves the topic's edge node and device segments to `gateways.sparkplug_id` / `devices.sparkplug_id`
   - Auto-quarantines unknown devices (sets `is_quarantined = true`)
   - Gates DDATA telemetry for quarantined devices
   - Writes valid telemetry to TimescaleDB `telemetry` hypertable, keyed by `sparkplug_id`
3. **PostgreSQL triggers** automatically log all changes to `digital_thread` audit table
4. **React dashboard** queries Supabase directly via PostgREST API with real-time subscriptions

### Asset Identity

Every gateway and device carries an immutable **`sparkplug_id`**: a 3-character type prefix
(`gwy` / `dev`) plus 21 lowercase hex characters, 24 in total. It is a `GENERATED ALWAYS ... STORED`
column derived from the row's UUID primary key (`supabase/migrations/20260101000014_sparkplug_identity.sql`),
so it cannot drift and needs no immutability trigger.

- **This is the identity on the wire.** It appears in the MQTT topic and keys `telemetry.asset_id`
  in TimescaleDB and `asset_config.asset_id` in Supabase.
- **`name` is a display label.** It is freely editable and no longer `UNIQUE` on gateways or devices
  — two cells can both contain a `Pump_01`. Renaming never detaches telemetry or re-quarantines.
- **The topic is authoritative**; the `Asset_ID` payload metric is a cross-check. A disagreement
  quarantines the device rather than one silently winning. `Asset_Name` is a hint used only to label
  a newly discovered device — it never overwrites an existing row's name.
- **Malformed identifiers quarantine with a diagnosis** (`quarantine_reason`), never dropped. The
  fixed width is what lets a truncated id be reported as such rather than as an unknown device.
- **Migration window:** ingestion falls back to matching by `name`, flagging the row
  `identity_source = 'legacy_name'` and warning. Remove that arm once all gateways are reconfigured.
- The frontend derives `sparkplug_id` from a UUID locally (`frontend/src/utils/sparkplugId.js`) —
  keep it in step with the SQL expression.

### Metric Grouping

Catalog metrics are categorised by the **first path segment of their name** (`Axes/C/ANGULAR_VELOCITY`
→ `Axes`), exposed as the generated column `metric_catalog.metric_group`
(`20260101000016_metric_group.sql`) and mirrored locally by `frontend/src/utils/metricGroup.js`.

- **The separator is `/`, never `.`** — it is what Sparkplug B uses for its own reserved names
  (`Node Control/Rebirth`, `Properties/Hardware Make`), what Factory+ uses for folders (a `.` is not
  even a legal character in a Factory+ metric name segment), and what MTConnect component paths use
  (`Axes/C/ANGULAR_VELOCITY`). Metric names are immutable, so this is not revisitable.
- Underscores are legal *inside* a segment — MTConnect data item types are `UPPER_SNAKE`.

- **The group is part of the name on the wire**, not a separate editable column — that is what makes
  it visible in MQTT, TimescaleDB and Grafana, none of which can read a Supabase-side column.
- **Only the first segment counts.** Deeper segments are display detail; treating them as groups
  would make the vocabulary unbounded.
- **No separator means `NULL`** (rendered `Ungrouped`), never a group named after the absence of one.
  Do not add a `CHECK` requiring a separator — names are immutable and an ungrouped metric is
  legitimate (`safety_interlock` and `max_temp_threshold` are seeded that way).
- Keep `deriveMetricGroup()` in step with the SQL expression, same obligation as
  `utils/sparkplugId.js`.

### MTConnect Vocabulary

`mtconnect_vocabulary` (`20260101000018_mtconnect_vocabulary.sql`) holds MTConnect's controlled
vocabularies: 249 data item types with their category, 123 subtypes, 100 units, 126 component types.

- **The migration is GENERATED.** Never hand-edit it — change
  `scripts/generate-mtconnect-vocabulary.mjs` and re-run. Bump `SCHEMA_VERSION` to adopt a newer
  MTConnect release.
- **It is a vocabulary, not a catalog.** `ANGLE` is a type; `Axes/C/ANGLE` is the metric. The
  standard cannot enumerate metrics because component instances are per-device. Do not seed data
  item types into `metric_catalog`.
- `metric_catalog` carries `category` (CHECK-constrained to SAMPLE/EVENT/CONDITION), `units`,
  `sub_type`, and `standard` (provenance; NULL means local extension, which MTConnect permits).
- **A subType goes into the name as well as its column** — Sparkplug keys only on the name, so
  ACTUAL and COMMANDED of the same type would collide on `UNIQUE(name)` otherwise.
- **Units are never auto-derived.** The schema carries a units *enum* but no per-type default, so
  units are a constrained choice. Only `SAMPLE` data items have them.
- **`AVAILABILITY` is a trap.** MTConnect's is an EVENT meaning "device connected"; the OEE
  availability *ratio* is ISO 22400. Never map one to the other. OEE stays ISO 22400 —
  MTConnect deliberately excludes computed KPIs.
- Adopting the vocabulary is not an MTConnect compliance claim (that needs the Implementer
  License). The Apache-2.0 schema repo is the source; the spec documents have separate terms.

The starter catalog was moved onto it by `20260101000019_mtconnect_catalog_migration.sql`.

- **Changing a metric is deprecate-and-supersede, never a rename** — `name` is immutable because a
  device is configured against that exact string. Set `deprecated` + `superseded_by`.
- **Values are part of the contract, not just names.** `Controller/EXECUTION` is
  READY/ACTIVE/INTERRUPTED/FEED_HOLD/STOPPED; `Controller/EMERGENCY_STOP` is ARMED/TRIGGERED (a
  *string*, and the inverse sense of the old boolean `safety_ok`). Anything reading these —
  `node_red_flow.json`, `grafana/provisioning/alerting/alerting.yml`, `OverviewTab`'s
  `getDeviceStatusColor` — must test `val_string`, not `val_bool`. A stale `val_bool` test compares
  NULL, evaluates false, and stops alerting silently.
- Live metric names: `Systems/TEMPERATURE`, `Axes/DISPLACEMENT`, `Controller/EXECUTION`,
  `Controller/EMERGENCY_STOP`, `Controller/FIRMWARE`, `SERIAL_NUMBER`, `OEE/{AVAILABILITY,
  PERFORMANCE,QUALITY}`, plus the local extensions `safety_interlock` and `max_temp_threshold`.

`metric_groups` (`20260101000017_metric_group_vocabulary.sql`) is a registry of approved group
**spellings**, not of group membership — membership is always derived from the name. Since 0018 it
is seeded from MTConnect's component types, with `standard` recording provenance.

- The Add Metric form composes the name from a group picker plus the rest of the name; it never
  takes the whole name as free text.
- `enforce_metric_group_spelling()` rejects a group differing only in case from a known one,
  checking the registry **and** groups already in use. It derives the group from `NEW.name`, not
  `NEW.metric_group` — generated columns are computed *after* `BEFORE` triggers, so the latter is
  still `NULL` there. Keep that expression in step with migration 0016 too.
- The picker's vocabulary is `knownGroupNames(registry, catalog)` — the union of both sources.
  Registry casing wins, because that is what the trigger treats as canonical.

### Device Tags

A device's type is **derived, never stored**: the distinct metric groups its assigned schema models
(`deviceGroupTags`), plus `Unmodelled` when it declared metrics outside that schema. One schema
covering `Robot.*` and `Environmental.*` metrics gives its devices both tags — which is why
multiple schemas per device were not needed.

- Tags come from the **schema**, not from observation. A provisioned device is therefore taggable
  before its first birth, and a metric published outside the schema confers no tag — it reports as
  `Unmodelled` instead, rather than quietly legitimising the drift.
- `devices.asset_type` is superseded and no longer written by the UI. Do not reintroduce a
  free-text classification field. Existing values still display, marked legacy.
- Tag filters (Devices, Telemetry, Digital Thread) resolve tag → device ids **client-side**, since
  the database does not model tags. On Telemetry that becomes an `IN` list against a view with no
  `LIMIT` pushdown, so a time window is required whenever a tag filter is active.
- Filtering `digital_thread` by tag matches devices that carry it **now**; the log records what was
  true then. The UI says so explicitly — keep that.

### Schema Conformance (Unmodelled Metrics)

`devices.last_birth_metrics` holds the metric names a device declared in its most recent `DBIRTH`
(`20260101000015_birth_metric_observation.sql`). Ingestion stores the **observation**; the verdict
is **derived at read time** in `frontend/src/utils/deviceTags.js`.

- **Never store the verdict.** Deriving it means editing a schema reclassifies its devices
  immediately; a stored flag would stay wrong until the device's next birth, and rebirths are rare.
- **Write only on change.** `log_digital_thread_event()` fires on every UPDATE to `devices`, so an
  unchanged rewrite per rebirth would append audit rows to an append-only table.
- **No schema, or an unreadable `schema_definition`, means no flag.** "Publishes beyond its model"
  and "has no model" are different findings.
- **`extract_declared_metrics()` is deliberately a separate pass from `store_birth_parameters()`**:
  the latter skips valueless metrics because it records parameter *values*; a metric declared with
  no value still needs modelling.
- `modelledMetrics()` reads the union of `properties` keys and `required` — `schema_definition` is
  free-form JSONB and hand-written schemas may carry either. `ingestion/validate.py` holds a Python
  mirror; keep the two in step.

### Realtime Change Feed

`supabase-realtime` publishes `cells`, `gateways`, `devices`, `digital_thread` (migration 0023).
Tabs subscribe through `hooks/useRealtimeTable.js`; `usePolling` stays at 60s as reconciliation.

- **`telemetry` is unpublishable, not merely unpublished.** It is a `postgres_fdw` foreign table
  (migration 0010) whose rows enter TimescaleDB's WAL, never Supabase's. Adding it to the
  publication does not error — it silently emits nothing, which is the worse failure. Do not
  "fix" the Telemetry tab by subscribing it.
- **Never delete `usePolling`.** Realtime has no replay: a dropped socket loses every change in
  the gap and the client is not told. The poll is also the only path carrying the 401 stop and
  exponential backoff.
- **The replication slot is created lazily, *after* `SUBSCRIBED`.** A client can be subscribed
  and receiving nothing. `useRealtimeTable` reloads once on `SUBSCRIBED` to close that window —
  keep that, it is not redundant with the initial load.
- **`REPLICA IDENTITY FULL` is required**, not cosmetic: Realtime evaluates RLS against the old
  row too, and with the default identity it only has the primary key.
- **Channels open only after authentication.** An unauthenticated subscriber still receives the
  event *envelope* (payload redacted to `{}` plus a 401 error), so subscribing pre-login leaks
  change timing. The hook checks `getSession()` itself rather than trusting callers.
- **Wall-clock-derived state needs `useClockTick`.** A gateway going quiet writes nothing, emits
  no event, and would otherwise keep its last-rendered status until the 60s poll.
- `VITE_ENABLE_REALTIME` is inlined by Vite at build time — flipping it requires rebuilding the
  frontend image, not restarting the container.

Four non-obvious container requirements, each of which crash-loops or 403s the service:
`RLIMIT_NOFILE` must be set (its `run.sh` uses it under `set -u`); the `_realtime` schema must
pre-exist (migration 0022); the tenant is `realtime-dev` and `TENANT_NAME` is ignored by
`SEED_SELF_HOST`; and Kong must address it as `realtime-dev.supabase-realtime` because Realtime
resolves the tenant from the leading hostname label. The compose alias and the kong.yml upstream
URL must change together.

### Scheduled Work & Event Dispatch

`pg_cron` (migration 0025) is **janitorial only** — pruning `net._http_response` and
`cron.job_run_details`, and honouring `auto_delete_at`. No job derives application state.

- **Gateway staleness is a VIEW (`public.gateway_status`, migration 0024), never a cron writer.**
  `log_digital_thread_event()` fires on every UPDATE to `gateways`, so a sweep writing `STALE`
  would append to an append-only audit table forever, and would be correct only between ticks.
  Keep the 90s threshold in step with `utils/gatewayStatus.js`, same obligation as
  `sparkplugId.js` and `metricGroup.js`.
- **The archive purge honours `auto_delete_at`, not `archived_at` age.** `NULL` means permanent
  retention and the UI says so. Purging on age would destroy rows the user marked to keep.
- `ensure_cron_job()` exists because `cron.schedule()` appends rather than replaces, and
  supabase-db-init replays every migration on every boot.

`pg_net` (migration 0027) fires the quarantine webhook. **It is a transition trigger, split
across INSERT and UPDATE — not a hook on `digital_thread` INSERT.** Ingestion stamps
`gateways.last_heartbeat` on every heartbeat, so a blanket hook would emit ~2 HTTP calls/min/
gateway of noise. `TG_OP` cannot appear in a `WHEN` clause (it is PL/pgSQL-only) and `OLD` is
unbound on INSERT, which is why it is two triggers sharing one function.

- pg_net has **no retries, ordering, or DLQ**. Advisory notifications only; use MQTT from the
  ingestion daemon if delivery must be guaranteed.
- `webhook_endpoints` has **no write RLS policy by design** — a writable endpoint table is an
  SSRF primitive. `anon` is revoked at the grant level too.

**Vault** holds only secrets read *from SQL*. `MQTT_PASSWORD` / `POSTGRES_PASSWORD` stay in
`.env` — they are needed before the database accepts connections, and duplicating them would
create two sources of truth.

### Grafana SSO

Grafana is an OAuth client of GoTrue's OAuth 2.1 server; `grafana-userinfo` maps
`public.user_roles` → Grafana org role. Five things are load-bearing:

- `GOTRUE_OAUTH_SERVER_ENABLED=true`. The discovery document is served unconditionally, so a
  `200` on `/.well-known/openid-configuration` proves nothing.
- **GoTrue ships no consent UI.** It redirects to `GOTRUE_SITE_URL + AUTHORIZATION_PATH`; the
  app serves that page (`pages/OAuthConsent.jsx`). Users must already be signed in to the
  dashboard. The **GET** on `/oauth/authorizations/{id}` is what binds the user — `/oauth/authorize`
  leaves `user_id` NULL — and a remembered consent makes that GET return a finished
  `redirect_url` instead of details.
- **Never request the `openid` scope**: `HS256 is not supported for ID token signing`, and the
  whole stack is HS256 on a shared secret. Identity comes from `api_url`.
- `auth_style = InHeader` in grafana.ini, matching `client_secret_basic` in `auth.oauth_clients`.
- `client_secret_hash` is `base64url(sha256(secret))` unpadded — **not bcrypt**.

Role mapping never reads the token: GoTrue's OIDC claims omit `app_metadata`. The edge function
omits `role` entirely when unmapped so `role_attribute_strict` refuses the login.

## Development Commands

### Initial Setup
```bash
npm run setup          # Creates .env from .env.example (cross-platform)
docker compose up --build -d   # Launch full stack (all services)
docker compose down -v         # Clean shutdown + volumes
```

### Frontend Development
```bash
cd frontend
npm run dev         # Start Vite dev server on port 3000
npm run build       # Production build
npm test            # Vitest unit tests
npm run test:cov    # Tests with coverage report
```

### End-to-End Validation
```bash
# Outside Docker (requires protoc installed)
protoc --python_out=. sparkplug_b.proto
cp sparkplug_b_pb2.py ingestion/
python ingestion/validate.py

# Or via Docker (protoc compiled automatically):
docker compose up -d
python ingestion/validate.py
```

### Database Migrations
- Located in `supabase/migrations/`
- Auto-applied on `supabase-db-init` container startup
- Edit existing migrations or create new timestamped `.sql` files

## Authentication & RBAC

### Default Demo Accounts (seeded via `supabase/seed.sql`)
| Email | Role | Access |
|-------|------|--------|
| `admin@factoryplus.local` | `Administrator` | Full CRUD |
| `manager@factoryplus.local` | `Shopfloor_Manager` | Full CRUD |
| `operator@factoryplus.local` | `Operator` | Read-only + telemetry view |
| `auditor@factoryplus.local` | `Auditor` | Digital thread read-only |

### Edge Functions
- `supabase/functions/approve-quarantine/` — Validates role claims (`Administrator`/`Shopfloor_Manager`) before approving quarantined devices
- `supabase/functions/deploy-nodered/` — Validates role claims before proxying Node-RED flow deployments
- `supabase/functions/grafana-userinfo/` — OIDC userinfo for Grafana's `api_url`; returns the
  standard identity claims plus `role` read from `public.user_roles`, and **omits `role`
  entirely** when unmapped so `role_attribute_strict` refuses the login

## Frontend Architecture

### Key Patterns
- **Lazy-loaded tabs** via React.lazy() for code splitting
- **Custom hooks**: `usePermissions`, `usePolling`, `useToast`, `useTheme`, `useAppRouting`, `useQuarantineAlerts`
- **Permission-based UI gating** via `hasPermission(uuid)` from `usePermissions`
- **Direct Supabase client** at `src/lib/supabaseClient.js`
- **Vitest** configured with globals enabled and jsdom environment
- **Derived state is computed client-side, not stored** — device tags, unmodelled metrics, metric
  grouping, gateway staleness and provisioning overdue all follow the same pattern: a pure function
  in `src/utils/`, unit-tested, with no backend cron and nothing persisted that could go stale.
- **Constrain table cells that hold variable-length data.** `.table-wrap` scrolls horizontally, so
  an unconstrained cell pushes the row's action buttons off-screen. This has bitten the quarantine
  queue twice (the birth payload, then the malformed-identity reason).

### Theming
- **Colours come from CSS variables in `App.css`** (`:root` / `[data-theme="light"]`). There is
  no Tailwind in this project.
- **Do not give `var()` a hardcoded fallback.** The sign-in card rendered white-on-white in
  light mode because it referenced `--text-main` / `--bg-main`, neither of which exists; the
  fallbacks made the typo look correct in dark mode and fail silently in light mode. The real
  names are `--text-primary` / `--bg-base`. `__tests__/authScreenTheme.test.jsx` now asserts
  that every variable referenced in `App.jsx` is one the stylesheet defines.
- Prefer the themed classes (`.card`, `.form-control`, `.form-label`) over inline colour styles.

### Shared Utilities
- `hooks/useRealtimeTable.js` — postgres_changes subscription; debounced, session-gated
- `hooks/useClockTick.js` — network-free re-render for wall-clock-derived state
- `utils/metricGroup.js` — metric name grouping; mirrors the SQL generated column
- `utils/mtconnect.js` — MTConnect vocabulary selectors and name composition
- `utils/deviceTags.js` — schema-derived device tags and unmodelled-metric detection
- `utils/deviceProvisioning.js`, `utils/gatewayStatus.js`, `utils/sparkplugId.js`

### Tab Components
- `OverviewTab` — Asset summary cards with quick filters
- `CellsTab` — Factory cell management
- `GatewaysTab` — Gateway configuration and status
- `DevicesTab` — Device listing. **Quarantined devices render in the onboarding queue banner
  only**; `filteredAssets` excludes `is_quarantined` before every other filter, so no filter
  combination can list one twice. `attentionCount` excludes them for the same reason (the queue
  has its own badge)
- `DigitalThreadTab` — Audit trail of all metadata changes
- `TelemetryTab` — Time-series data viewer (connects to TimescaleDB)
- `SchemasTab` — Metric catalog (what devices publish), browsable MTConnect vocabulary panel
  (`common/MTConnectVocabularyPanel`), and the schema registry
- `DirectoryTab` — Directory service configuration
- `ArchivesTab` — Soft-deleted records restoration

### Constants
- `src/constants.js` — Permission UUIDs (`PERMISSION_UUIDS`) and role mappings

## Database Schema

### Core Tables
- `cells` — Factory cell/groupings (`name` is still `UNIQUE`; cells are not addressed on the wire)
- `gateways` — Edge gateways linked to cells; `sparkplug_id` generated column
- `devices` — Devices linked to gateways, `is_quarantined` flag; `sparkplug_id` generated column,
  plus `reported_identity` / `quarantine_reason` / `identity_source` for quarantine diagnostics,
  and `last_birth_metrics` / `last_birth_metrics_at` for birth-metric observation (see below)
- `digital_thread` — Auto-populated audit log via triggers
- `documents`, `asset_config`, `schemas`, `directory_services` — Extended metadata
- `roles`, `permissions`, `role_permissions`, `user_roles` — RBAC tables.
  ⚠️ `roles_id_seq` was never advanced past `seed.sql`'s explicit ids, so inserting a **new**
  role without an explicit id fails on `roles_pkey`. Fix with
  `SELECT setval('public.roles_id_seq', (SELECT max(id) FROM public.roles));` before adding one
- `webhook_endpoints` — outbound webhook targets; migration-managed, **no write RLS policy**
- `gateway_status` (view) — `gateways` plus read-time `live_status` / `is_stale`

### TimescaleDB
- `assets` dimension table — `asset_id` is the device's `sparkplug_id`; `asset_name` is a
  display-only cached label refreshed on every birth
- `telemetry` hypertable with columns: `time`, `asset_id`, `metric_name`, `val_double`, `val_string`, `val_bool`

## CI Pipeline

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):
1. **frontend-build** — Install deps, run `npm test`, build production bundle
2. **edge-function-auth-test** — Run Python unit tests for auth validation
3. **e2e-validation** — Launch Docker stack, poll health, run `ingestion/validate.py`

## Important Notes

- **Fail-closed security**: Edge functions and RLS policies deny access by default; missing role claims result in `403 Forbidden`
- **Quarantine gating**: Unregistered devices auto-insert into Supabase with `is_quarantined=true`; telemetry for quarantined devices is dropped. The arriving edge node is recorded on the row, so approval does not require re-picking the gateway
- **Renaming is safe**: `name` carries no identity (see Asset Identity above). Do not reintroduce name-based lookups — the `isUuid()` format-sniffing that used to guard them has been removed
- **Digital Thread**: PostgreSQL `log_digital_thread_event()` trigger automatically logs INSERT/UPDATE/DELETE on cells, gateways, and devices
- **Cross-platform setup**: `scripts/setup.mjs` uses Node.js fs module (no POSIX shell required)
- **paho-mqtt v1 API**: Ingestion code intentionally uses v1 callback signatures; upgrading to v2 requires migration
