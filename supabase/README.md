# Supabase Backend

Schema, row-level security, triggers, and the four edge functions. Supabase is the authoritative
store for **asset metadata**; time-series telemetry lives in TimescaleDB and is reached through a
foreign-data-wrapper view.

| Path | Purpose |
| :--- | :--- |
| [`migrations/`](migrations) | `0001` schema, `0002` seed data, then additive migrations `0003`–`0007` |
| [`migrations/archive/`](migrations/archive) | The 38 pre-beta migrations, preserved for their reasoning. **Never executed** |
| [`functions/`](functions) | Deno edge functions and the worker router |
| [`kong.yml`](kong.yml) | API gateway routes, CORS, and `key-auth` consumers. **A template** |
| [`seed.sql`](seed.sql) | Demo user accounts |

---

## Migration Baseline

Squashed to a **two-file baseline** for the public beta, plus additive remediation migrations:

| File | Contents |
| :--- | :--- |
| `0001_baseline_schema.sql` | Pure DDL. Tables, views, functions, triggers, policies, grants |
| `0002_seed_data.sql` | Pure DML. RBAC, vocabularies, metric catalog, demo assets, cron, Vault |
| `0003_audit_immutability_and_quarantine_rpc.sql` | Append-only enforcement and the atomic approval RPC |
| `0004_drop_gateway_ip_address.sql` | Removes a column nothing read |
| `0005_digital_thread_signal_and_attribution.sql` | Stops the audit trigger recording machine non-events |
| `0006_nodered_oidc_auth.sql` | Node-RED's OAuth client and the webhook signing key |
| `0007_metric_catalog_name_check.sql` | Constrains `metric_catalog.name` to the Factory+ format |
| `0008_gateway_sparkplug_group.sql` | Adds `gateways.sparkplug_group`, making the edge node address `(group, node)` |

Add schema changes as a **new numbered file** (`0008_…`). The baseline files describe the state a
fresh database is built into; a live database has already run them.

### Prefixes must be unique, and the order is the filename

`supabase-db-init` applies `/migrations/*.sql` in **glob order** with no applied-migrations
ledger, so the filename *is* the execution order. Two files sharing a prefix still both run —
lexically, by whatever follows the number — which means the order is decided by an accident of
naming and can change under a rename that looks purely cosmetic. Nothing fails, nothing logs; the
ordering is simply not the one anybody chose.

`scripts/check-docs-drift.mjs` asserts unique prefixes across **both** `supabase/migrations/` and
the chart mirror at `deploy/helm/factoryplus/files/migrations/`, and that the two directories hold
the same set. `0006_nodered_oidc_auth.sql` was renumbered from `0003` for exactly this reason.

> Renaming a migration means re-running `node scripts/sync-helm-chart-files.mjs`. It removes the
> orphaned mirror copy; leaving it behind would replay one migration **twice, under two names**,
> on the Kubernetes target only.

### Idempotency is not optional

`supabase-db-init` replays **every** `/migrations/*.sql` on every boot — there is no
applied-migrations ledger. A raw `pg_dump` baseline installs on the first boot and takes the stack
down on the second. Every statement uses `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE`, or
`DROP … IF EXISTS` ahead of every constraint, policy and trigger.

The glob does **not** recurse, which is why `archive/` is mounted but never applied.

### Three defects the squash verification caught

The old chain and the baseline were built into separate databases and diffed — statement sets,
per-table content hashes, and the `anon`/`authenticated` privilege set. Inspection alone would not
have caught:

- **`SET check_function_bodies = false` is required.** PL/pgSQL resolves `%ROWTYPE` at `CREATE`
  time, so `fork_schema()` cannot precede `public.schemas`. No single ordering satisfies every such
  dependency in both directions.
- **`pg_dump` records only positive grants**, so the chain's `REVOKE`s vanished and `anon` silently
  regained `GRANT ALL` on every table. Hence the explicit privilege reset in `0001`.
- **Constraints must be guarded, not dropped and re-added** — `DROP CONSTRAINT IF EXISTS
  cells_pkey` fails on any populated database with foreign keys pointing at it.

See [`migrations/archive/README.md`](migrations/archive/README.md).

### Dropping a `gateways` column (0004)

`ip_address` was captured on the gateway form and on quarantine approval, and shown as a column,
but nothing ever acted on it: not in the search haystack, no view or function derived anything
from it, ingestion resolves edge nodes by `sparkplug_id`, and the AAS exporter does not read it.
Operators were being asked to keep a field accurate for no consumer.

**The view must be dropped and rebuilt, never CASCADEd.** `public.gateway_status` selects from
`public.gateways`, so PostgreSQL refuses:

```
ERROR:  cannot drop column ip_address of table gateways because other objects depend on it
DETAIL: view gateway_status depends on column ip_address of table gateways
```

`DROP COLUMN … CASCADE` would "work" by dropping the view with it — and the gateways page would
404 on `gateway_status` until someone noticed. Rebuilding from `ensure_gateway_status_view()` is
the honest form of the same operation, and is exactly what that function exists for: its body
selects `g.*`, so it picks up the new column set on its own.

`gateway_status` was confirmed to be the only dependent object:

```sql
SELECT DISTINCT dependent.relname
FROM pg_depend d
JOIN pg_rewrite r       ON r.oid = d.objid
JOIN pg_class dependent ON dependent.oid = r.ev_class
JOIN pg_class src       ON src.oid = d.refobjid
JOIN pg_attribute a     ON a.attrelid = src.oid AND a.attnum = d.refobjsubid
WHERE src.relname = 'gateways' AND a.attname = 'ip_address';
```

**Fresh and existing databases converge**, which is the property that matters when one file set
serves installs *and* upgrades. `0001` no longer creates the column in either of the two places it
appeared — the `CREATE TABLE` and the expanded column list of its inline `gateway_status`
definition, which `pg_dump` wrote out as explicit columns rather than `g.*`. Removing only the
first would leave `0001` failing on a fresh database with `column g.ip_address does not exist`
while every existing database kept working, because `CREATE TABLE IF NOT EXISTS` is a no-op there.

- **fresh** — `0001` builds the table without the column; `0004`'s DROP is a no-op.
- **existing** — `0001`'s CREATE is a no-op; `0004`'s DROP removes the column.

> **Adding a column to `gateways` carries the same obligation in reverse:** call
> `ensure_gateway_status_view()`, because `CREATE OR REPLACE VIEW` cannot widen a `g.*` view in
> place.

### Audit signal and attribution (0005)

On a stack running **one** simulated gateway and **one** device, `digital_thread` was taking
**175 rows/hour**, of which 123 in the first hour had `changed_by IS NULL`:

| entity | action | what actually differed | rows |
| :--- | :--- | :--- | ---: |
| `gateways` | UPDATE | `last_heartbeat` only | 84 |
| `gateways` | UPDATE | `last_heartbeat`, `status` | 1 |
| `devices` | UPDATE | **nothing at all** (`old = new`) | 33 |

**Attribution alone would not have helped.** `changed_by` was NULL because these were not things a
person did — a gateway sending a heartbeat has no author. Labelling them "the ingestion daemon"
would have faithfully described 175 rows an hour and left the log exactly as unreadable. At 50
gateways that is ~210k rows/day into an append-only table, burying the handful of rows that record
an operator changing something.

Two of the three sources are not events at all:

- The 33 device rows had `old_data = new_data`. Ingestion re-sends `status='ONLINE'` on every
  rebirth (60s), and an `AFTER UPDATE` trigger fires whether or not any value changed. **A write
  that changed nothing is not a change.**
- `last_heartbeat` is liveness telemetry, not metadata. Nothing reads it from the audit log —
  `public.gateway_status` derives staleness from the live column at read time, which is precisely
  why it is a view and not a stored status.

This discipline was already applied to the quarantine webhook (a blanket hook would emit ~2 HTTP
calls/min/gateway of noise) and to `record_declared_metrics`, which writes only on change. The
audit trigger was the one place it had not been.

`actor_source` is a **closed set** (`user` / `ingestion` / `migration` / `service`) because one of
its sources is a request header a client supplies, and an audit column must not become free text
an arbitrary caller can write into. The trigger never accepts `user` from that header — a client
asserting a human author for its own writes is exactly the claim it must not be able to make.

Once machine writes say so explicitly, `actor_source IS NULL` stops meaning "probably a heartbeat"
and starts meaning **"we lost track of this"** — a reportable defect rather than the normal case.

### Metric name format (0007)

Factory+ requires a metric name to be `/`-delimited folders whose segments use only alphanumerics
and the underscore: `^[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$`. `.` is not a legal character.

**`metric_catalog.name` is immutable**, so a non-conforming name is *permanent* — the row can only
be deprecated and superseded, never corrected. The constraint is cheap now and impossible later.

**It is added `NOT VALID`, and that is the whole design.** `supabase-db-init` runs
`psql -v ON_ERROR_STOP=1` over every migration on every boot with no ledger, so a plain
`ADD CONSTRAINT` that failed on one legacy row would not fail once — it would fail on **every
boot, forever**, and the stack would never come up again. `NOT VALID` still enforces on `INSERT`
and `UPDATE`, so new rows are constrained immediately; only the back-scan is deferred.

The migration then attempts `VALIDATE CONSTRAINT` inside an exception handler. On failure it
raises a **`WARNING`** naming the offending rows and leaves the constraint `NOT VALID`, so it
re-checks and re-warns on the next boot. A warning that stopped appearing because the migration
gave up would be worse than no warning.

To clear one: deprecate the offending metric, add a conforming replacement, set `superseded_by`,
then

```sql
ALTER TABLE public.metric_catalog VALIDATE CONSTRAINT metric_catalog_name_format;
```

`METRIC_NAME_PATTERN` in [`frontend/src/utils/metricGroup.js`](../frontend/src/utils/metricGroup.js)
mirrors this expression so the operator is told at the form rather than by a `400` — the same
keep-in-step obligation `deriveMetricGroup()` and `utils/sparkplugId.js` carry.

All 15 seeded catalog names conform, so the constraint validates cleanly on a fresh database.

### The Sparkplug group is part of the address (0008)

Ingestion parsed `spBv1.0/<group>/<type>/<node>/<device>` and **never read the group**, so two
groups publishing the same edge node id resolved to one row — silently, each group's telemetry
attributed to the other's asset. `gateways.sparkplug_group` closes that, and is what makes
`/v1/address/{group_id}/{node_id}` mean anything.

Resolution order in `resolve_gateway()`, with the middle arm as the migration path:

1. `(sparkplug_group, sparkplug_id)` — the current scheme.
2. `sparkplug_id` alone — warns `DEPRECATED IDENTITY`, throttled, naming both the group on the
   wire and the one on the row. **Not a refusal**: a fleet is reconfigured one gateway at a time,
   and refusing here would strand every device behind a node not yet corrected.
3. `name` — legacy, pre-`sparkplug_id`.

The resolution cache is keyed by the **pair**. A cache keyed on the node alone would hand a hit
from one group to a request from another — precisely the collision this closes.

> **Adding a column to `gateways` requires `ensure_gateway_status_view()`.** `0008` calls it, and
> `0001` no longer carries a second, explicit-column copy of the view — see below.

### `0001` builds `gateway_status` by calling the function, not inline

`pg_dump` expanded the view into an **explicit column list** when the baseline was squashed, while
`ensure_gateway_status_view()` selects `g.*`. Those drift apart the moment a later migration adds
a gateways column: `0008` widened the view, and `0001`'s replay on the next boot tried to recreate
it from the older, narrower list:

```
ERROR:  cannot drop columns from view
```

`db-init` runs with `ON_ERROR_STOP=1`, so that is not a warning — **the stack never comes up
again**, and it surfaces on the *second* boot rather than the first. `0004` hit the same wall from
the opposite direction when a column was removed.

`0001` now calls the function, leaving one definition of the view in the repository. The function
drops and recreates rather than replacing, which is also what re-applies the `COMMENT` and the
grants — `DROP VIEW` discards both, which is why they live inside it.

---

## Core Tables

| Table | Notes |
| :--- | :--- |
| `cells` | Factory groupings. `name` is still `UNIQUE` — cells are not addressed on the wire |
| `gateways` | Edge gateways. `sparkplug_id` generated column, `location_scope`, `last_heartbeat` |
| `devices` | `sparkplug_id`, `is_quarantined`, quarantine diagnostics, `last_birth_metrics`, `model_3d_path`, `cell_id` |
| `digital_thread` | **Append-only** audit log, written only by trigger |
| `metric_catalog` | What devices publish. `name` is **immutable** |
| `metric_groups` | Registry of approved group *spellings* — membership is always derived from the name |
| `schemas` | Versioned. `version` / `parent_schema_id` / `status` / `change_description` |
| `device_submodels` | Many schemas per device, one AAS Submodel each |
| `mtconnect_vocabulary`, `iso22400_vocabulary`, `opcua_vocabulary` | Reference data. `SELECT` to `authenticated`, everything else revoked |
| `roles`, `permissions`, `role_permissions`, `user_roles` | RBAC |
| `webhook_endpoints` | Outbound targets. **No write RLS policy by design** — a writable endpoint table is an SSRF primitive |

### Views

| View | Resolves |
| :--- | :--- |
| `gateway_status` | `gateways` plus read-time `live_status` / `is_stale` (90 s threshold) |
| `device_locations` | A device's effective cell: `COALESCE(device.cell_id, gateway.cell_id)` |
| `device_schemas` | Union of `device_submodels` join rows, falling back to `devices.schema_id` |
| `telemetry` | `security_invoker` view over `timescale.telemetry`, a `postgres_fdw` foreign table |

> The raw foreign table lives in its own `timescale` schema, deliberately kept out of
> `PGRST_DB_SCHEMAS` so it is never routable. Only the view is exposed, and `anon` reaches neither.

---

## RLS Privilege Matrix

Every table has `ENABLE ROW LEVEL SECURITY`. The pattern is uniform and fail-closed.

| Table group | SELECT | INSERT / UPDATE / DELETE |
| :--- | :--- | :--- |
| `cells`, `gateways`, `devices`, `documents`, `asset_config`, `schemas`, `device_submodels`, `directory_services`, `metric_catalog`, `metric_groups` | `authenticated` | `Administrator`, `Shopfloor_Manager` |
| `digital_thread` | `Administrator`, `Shopfloor_Manager`, `Auditor` | **nobody** — see below |
| `*_vocabulary` | `authenticated` | **no write policy at all** |
| `roles`, `permissions`, `role_permissions` | `authenticated` | none |
| `user_roles` | own row, or `Administrator` / `Shopfloor_Manager` | none |
| `webhook_endpoints` | `Administrator` | **no write policy** |

### `has_role()`

```sql
public.has_role(allowed_roles text[]) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
```

Reads `public.user_roles` **directly rather than trusting a JWT claim**. This is deliberate: a role
revocation takes effect on the next query, not on the next token refresh.

`custom_access_token_hook()` also mirrors the role into `app_metadata.role` for clients that want
it — but **nothing authorises on that claim**. The edge functions were corrected during pre-beta
remediation to read the table too, because falling back to the claim when no row was found inverted
the meaning of a revocation.

---

## Audit Trail (`digital_thread`)

Written exclusively by `log_digital_thread_event()`, an `AFTER INSERT OR UPDATE OR DELETE` trigger
on `cells`, `gateways` and `devices`.

### Append-only, enforced three ways

1. **No INSERT/UPDATE/DELETE grant** to `authenticated`.
2. **`TRUNCATE`, `REFERENCES` and `TRIGGER` revoked.** These were left behind by an original
   `REVOKE INSERT, UPDATE, DELETE` issued against a prior `GRANT ALL` — and **`TRUNCATE` bypasses
   RLS entirely**, so the SELECT policy did not constrain it.
3. **`enforce_digital_thread_append_only()`** — a `BEFORE UPDATE OR DELETE` trigger that raises for
   every application role, `service_role` included. The service key ships in `.env` and is held by
   ingestion and all four edge functions, so an audit trail that key could rewrite was not much of
   an audit trail.

> **Scope, stated honestly.** The trigger exempts `postgres` and `supabase_admin` because a role
> that can issue DDL can drop the trigger anyway. What it *does* close is every path reachable over
> PostgREST — and PostgREST cannot execute DDL, so for `authenticated` and `service_role` it is a
> real boundary rather than a speed bump.

### Attribution

`changed_by` records `auth.uid()`. Edge functions mutate with the service-role client, whose JWT
carries no `sub` — so **every privileged write used to be logged anonymously** (58 of 65 rows on
the audited database had `changed_by IS NULL`).

`log_digital_thread_event()` now falls back to a session-local GUC, `factoryplus.actor_id`, which
`approve_quarantined_device()` sets with `SET LOCAL`. `auth.uid()` still wins when present — a
direct PostgREST write by a signed-in user is already correctly attributed, and the GUC must not be
able to override it.

---

## Key Triggers

| Trigger | Table | Purpose |
| :--- | :--- | :--- |
| `trg_*_digital_thread` | `cells`, `gateways`, `devices` | Audit logging |
| `trg_digital_thread_append_only` | `digital_thread` | Rejects UPDATE/DELETE |
| `trg_metric_catalog_immutability` | `metric_catalog` | `name` and `datatype` are wire contracts |
| `trg_metric_group_spelling` | `metric_catalog` | Rejects a group differing only in case |
| `trg_enforce_schema_version_provenance` | `schemas` | A version may only be created by `fork_schema()` |
| `trg_prevent_active_schema_mutation` | `schemas` | A published version is frozen |
| `trg_device_quarantine_webhook_{insert,update}` | `devices` | pg_net notification on transition to quarantined |

> The quarantine webhook is **two triggers sharing one function**, split across INSERT and UPDATE,
> because `TG_OP` cannot appear in a `WHEN` clause and `OLD` is unbound on INSERT. It is a
> *transition* trigger, not a hook on every write — ingestion stamps `last_heartbeat` constantly,
> so a blanket hook would emit ~2 HTTP calls/min/gateway of noise.

---

## Edge Functions

All fail closed: missing or unrecognised role ⇒ `403`.

| Function | Roles | Notes |
| :--- | :--- | :--- |
| [`approve-quarantine`](functions/approve-quarantine) | `Administrator`, `Shopfloor_Manager` | Calls the atomic approval RPC |
| [`deploy-nodered`](functions/deploy-nodered) | `Administrator`, `Shopfloor_Manager` | Deploys **only** the committed flow |
| [`aas-export`](functions/aas-export) | + `Operator`, `Auditor` | Export is a read |
| [`grafana-userinfo`](functions/grafana-userinfo) | any mapped role | OIDC userinfo for Grafana SSO |
| [`nodered-userinfo`](functions/nodered-userinfo) | any mapped role | The same lookup in Node-RED's permission vocabulary |
| [`fplus-directory`](functions/fplus-directory) | any authenticated user | Factory+ Directory adapter — see below |

### The Factory+ Directory adapter

`fplus-directory` serves the read half of the Factory+ Directory component's REST contract by
**projecting** tables that already exist. Nothing upstream of it knows the Directory exists — no
column, trigger or ingestion path changed to support it, exactly as `aas-export` is an adapter
rather than an adopted format.

| Endpoint | Returns |
| :--- | :--- |
| `GET /ping` | Service identity and version. **Unauthenticated by specification** |
| `GET /v1/device` | A JSON array of `Instance_UUID`s |
| `GET /v1/device/{uuid}` | One device's Sparkplug address, status and schemas |
| `GET /v1/address/{group}/{node}` | The edge node at that address and the devices behind it |
| `GET /v1/schema` · `GET /v1/service` | Locally minted schema / service identifiers |

**It is served at the unprefixed paths**, not under `/functions/v1/`, because a Factory+ client has
no Supabase `apikey` and no way to acquire one. Those Kong routes are therefore exempt from
`key-auth` — which makes the function itself the **only** thing in front of the fleet's address
space. Every `/v1/` path refuses a request with no bearer token *before it routes*, and
`validate.py` check 11b asserts that 401 rather than trusting it.

It **queries as the caller**, not as the service role: a Directory is a live read over the whole
address space, so running it privileged would hand every authenticated user a view their RLS
policies do not grant them. Its entry in `FUNCTION_REGISTRY` grants no `SUPABASE_SERVICE_ROLE_KEY`,
which makes that structural rather than a discipline.

**What it does not claim.** Schema and service identifiers are this deployment's own UUIDs, and the
response says so (`"namespace": "local"`). Factory+ `Schema_UUID`s are registered against the AMRC
schema repository; returning local ids unqualified would assert an interoperability that does not
exist — the same rule the semantic-id namespace follows.

Two identity mappings need no new columns, which is why this is an adapter and not a migration:
`Instance_UUID` is `devices.id` (already RFC4122), and the Sparkplug address is
`(gateways.sparkplug_group, gateways.sparkplug_id)`.

### The worker router

`supabase/functions/main/index.ts` spawns each function as an isolated Deno worker. Two controls:

- **An explicit function allow-list.** `serviceName` comes from the request path, and the edge
  runtime boots with `VERIFY_JWT="false"` because each function checks its own role — so without
  the list, any directory under the mount was bootable by name. An unknown name is a `404` decided
  by the router, not by a worker that starts and then decides.
- **Per-function environment.** The router previously forwarded `Deno.env.toObject()` — the
  *complete* environment — to every worker, handing `SUPABASE_SERVICE_ROLE_KEY`,
  `NODERED_ADMIN_TOKEN` and `GRAFANA_OAUTH_CLIENT_SECRET` to functions with no use for them. Each
  registry entry now lists only what that function reads.

Because each worker is isolated, shared code **cannot** be imported from a sibling directory — a
worker only reads files beneath its own service path. That is why `resolveUserRole` and
`sparkplugToXsd` are duplicated rather than extracted ([issue #9](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/9)).

### `approve_quarantined_device()`

The merge path used to be four sequential PostgREST calls with no transaction and no compensating
rollback: re-key `asset_config`, update the surviving device, delete the duplicate. A failure
partway left `asset_config` pointing at a device that was never merged, or two un-quarantined rows
claiming one physical asset.

It is now one `SECURITY DEFINER` RPC — atomic, granted to `service_role` only, taking the
authenticated `p_actor_id` explicitly and **re-checking that actor's role against
`public.user_roles`** so authorisation does not rest solely on the caller's check.

---

## API Gateway (`kong.yml`)

**This file is a template, and ONE template serves both deployment targets.** Kong 2.8 has no
environment interpolation in declarative config, and committing literal keys would make `.env` no
longer authoritative — so the `__UPPER_SNAKE__` placeholders are substituted outside the container on
both paths:

| | Substituted by | Notes |
| :--- | :--- | :--- |
| Docker Compose | `supabase-kong-init` (`sed` into a volume) | |
| Kubernetes | an initContainer in the Kong pod (`sed` into an `emptyDir`) | `supabase-kong-init` has no counterpart |

**Not by Helm at template time**, which is the tempting shortcut and breaks the externally-managed
Secret path in the worst way available: with the Secret owned outside the chart the chart cannot see
the key values, Helm would substitute **empty strings**, and Kong would register empty API keys —
*which `key-auth` accepts*. A gateway that reports healthy with its authentication silently off.

`__REALTIME_UPSTREAM_URL__` is a placeholder for the same reason but a different one: it is the only
upstream that genuinely differs between the targets. Realtime resolves its tenant from the **leading
hostname label**, so it is `realtime-dev.supabase-realtime` (a Compose network alias) or
`realtime-dev` (a Kubernetes Service *named* for the tenant). Both substituters validate that label
and refuse anything else — addressing it by the plain service name makes every WebSocket handshake
fail with a bare 403 that mentions neither tenants nor hostnames.

**Adding a placeholder means adding it to both substituters.** Each scans for surviving markers and
fails loudly, and each skips comment lines — because the template documents the convention by name,
so a whole-file scan would flag the documentation of the rule as a violation of it.

**The edge functions are delivered differently too.** Compose bind-mounts `functions/` for hot-reload;
Kubernetes bakes them into an image (`functions/Dockerfile`, built with the **repository root** as
context because `node_red_flow.json` lives there). Baking is what makes "which revision of
`aas-export` is running" a property of the deployed artefact, so a rollback rolls the functions back.

`key-auth` is enabled on `/rest/v1/`, `/realtime/v1/`, `/storage/v1/` and `/functions/v1/`.
**Two routes are deliberately open**, and both are load bearing:

| Route | Why |
| :--- | :--- |
| `/auth/v1/` | GoTrue authenticates its own callers, and is the OAuth 2.1 server Grafana talks to — an OAuth client presents client credentials, not a Supabase apikey. Sign-in must also work before any session exists |
| `/storage/v1/object/public/` | An AAS `File` URL must be dereferenceable by a viewer holding no session. Requiring a key would break every shell already handed out |

The public-object exemption is a **separate service** with `/object/public/` baked into its
upstream URL, not an exempt route, because `strip_path: true` would otherwise remove the segment
storage-api routes on.

> Adding a plugin name to `KONG_PLUGINS` **replaces** the default `bundled` set rather than adding
> to it. `key-auth` had to be named explicitly or Kong would refuse to start on a config
> referencing it.

---

## Schema Versioning

A published schema is **read-only**. Changing one means forking the next version, editing the
draft, and publishing it.

`fork_schema()` and `publish_schema_version()` are RPCs, not table writes: `version` is computed
from the parent, and publishing must repoint every device and archive the predecessor in one
transaction. `enforce_schema_version_provenance()` rejects a directly-inserted version and
`prevent_active_schema_mutation()` rejects a directly-flipped status — **no manual version input is
possible**.

The freeze is **deny-by-default**: the guard diffs `to_jsonb(NEW)` against `to_jsonb(OLD)` with
`status` removed, so a column added later is frozen when it exists, not when someone remembers.

It binds app-facing roles only (`authenticated`/`anon`/`service_role`), and that is load bearing —
migrations rewrite seeded schemas by name on every boot, so a guard binding `postgres` would break
db-init the first time anyone published a v2. The **status-transition check sits above that bypass**
and binds everyone: history that can be re-opened is not history.

---

## Adding a vocabulary

A **vocabulary** is reference data describing what a standard *defines*. It is deliberately separate
from `metric_catalog`, which records what a device actually *publishes* — that separation is the
reason a vocabulary can be replaced wholesale without touching device configuration. The seeded
standards and how each identity was verified are in [`../docs/vocabularies.md`](../docs/vocabularies.md).

Every vocabulary must satisfy all nine, and CI checks five of them:

1. Migration is **idempotent** (`ON CONFLICT … DO UPDATE`) — db-init replays it every boot.
2. RLS enabled, SELECT policy for `authenticated`, `REVOKE ALL FROM PUBLIC, anon`, no write policy.
3. `metric_groups` rows registered in the migration, carrying `standard` provenance.
4. `NOTIFY pgrst, 'reload schema'`.
5. `node scripts/sync-helm-chart-files.mjs` run and committed (CI checks it with `--check`).
6. Migration header carries a ⚠ VERIFY block naming what was and was not confirmed against the
   source document. **Seeds are transcriptions**; generate them from the machine-readable source
   rather than typing them, and say which source.
7. Frontend mirror module plus unit tests; check whether `scripts/check-docs-drift.mjs` or
   `scripts/check-mirror-drift.mjs` needs a new pair.
8. `docs/openapi.yaml` updated if any endpoint shape changes.
9. **A `STANDARD_NAMESPACES` entry in [`../i3x/address_space.py`](../i3x/address_space.py).** This
   is the one that fails silently: i3X maps `metric_catalog.standard` onto a Namespace, so a
   standard with no entry is **omitted from `GET /namespaces`** — a 200 with a shorter list, which
   reads as "this deployment does not use that standard". The key must be the exact `standard`
   string the migration writes.

---

## Testing

```bash
# No stack required — spins up its own Postgres in CI
python supabase/migrations/test_user_roles_rls.py
python supabase/migrations/test_schema_versioning.py
python supabase/functions/approve-quarantine/test_approve_quarantine.py
python supabase/functions/deploy-nodered/test_deploy_nodered.py
python supabase/functions/aas-export/test_aas_export.py
```

`test_schema_versioning.py` runs its assertions as `authenticated` with simulated JWT claims,
because the immutability guard deliberately exempts the owner — a suite connecting as `postgres`
would pass against a database with the trigger dropped.

`test_aas_export.py` has two layers: offline checks (the Sparkplug→XSD mapper parity guard and the
authorization ladder) always run; live checks invoke the deployed function and validate the emitted
document against the **official IDTA schema**, skipping when no stack is reachable.

---

## Related

- [`../ingestion/README.md`](../ingestion/README.md) — Sparkplug parsing and telemetry mapping
- [`../frontend/README.md`](../frontend/README.md) — how the UI consumes this API
- [`migrations/archive/README.md`](migrations/archive/README.md) — squash verification notes
