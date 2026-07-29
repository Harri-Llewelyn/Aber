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
| **Edge** | Node-RED | 1880 | Edge flow automation |
| **Monitoring** | Grafana | 3002 | Time-series dashboards |

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

## Frontend Architecture

### Key Patterns
- **Lazy-loaded tabs** via React.lazy() for code splitting
- **Custom hooks**: `usePermissions`, `usePolling`, `useToast`, `useTheme`, `useAppRouting`, `useQuarantineAlerts`
- **Permission-based UI gating** via `hasPermission(uuid)` from `usePermissions`
- **Direct Supabase client** at `src/lib/supabaseClient.js`
- **Vitest** configured with globals enabled and jsdom environment

### Tab Components
- `OverviewTab` — Asset summary cards with quick filters
- `CellsTab` — Factory cell management
- `GatewaysTab` — Gateway configuration and status
- `DevicesTab` — Device listing with quarantine status
- `DigitalThreadTab` — Audit trail of all metadata changes
- `TelemetryTab` — Time-series data viewer (connects to TimescaleDB)
- `SchemasTab` — Sparkplug B schema registry
- `DirectoryTab` — Directory service configuration
- `ArchivesTab` — Soft-deleted records restoration

### Constants
- `src/constants.js` — Permission UUIDs (`PERMISSION_UUIDS`) and role mappings

## Database Schema

### Core Tables
- `cells` — Factory cell/groupings (`name` is still `UNIQUE`; cells are not addressed on the wire)
- `gateways` — Edge gateways linked to cells; `sparkplug_id` generated column
- `devices` — Devices linked to gateways, `is_quarantined` flag; `sparkplug_id` generated column,
  plus `reported_identity` / `quarantine_reason` / `identity_source` for quarantine diagnostics
- `digital_thread` — Auto-populated audit log via triggers
- `documents`, `asset_config`, `schemas`, `directory_services` — Extended metadata
- `roles`, `permissions`, `role_permissions`, `user_roles` — RBAC tables

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
