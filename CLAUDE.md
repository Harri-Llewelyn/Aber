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
| **Storage** | Supabase storage-api | - | 3D asset models via `/storage/v1/`; one public bucket |
| **Edge** | Node-RED | 1880 | Edge flow automation |
| **Monitoring** | Grafana | 3002 | Time-series dashboards (SSO via Supabase Auth) |
| **i3X** | Python HTTP server | 8090 | CESMII i3X 1.0 read API; own `spBv1.0/#` subscription |

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
column derived from the row's UUID primary key (`supabase/migrations/archive/20260101000014_sparkplug_identity.sql`),
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

- **The rows are GENERATED.** Never hand-edit them — change
  `scripts/generate-mtconnect-vocabulary.mjs` and re-run. Bump `SCHEMA_VERSION` to adopt a newer
  MTConnect release. They live in `0002`'s marked block; CI fails on an edited block via the
  SHA-256 in the BEGIN marker. See **Database Migrations** for why the generator writes there
  rather than into `archive/`.
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

### ISO 22400 and OPC UA Vocabularies

`iso22400_vocabulary` (`20260101000030`) holds 8 KPI definitions; `opcua_vocabulary`
(`20260101000031`) holds 25 companion-specification data points from OPC 40001 (Machinery) and
OPC 40010 (Robotics). Both follow `mtconnect_vocabulary`'s stance exactly: reference data, no write
policy, `anon` revoked, maintained by editing the migration.

- **Three standards, not three alternatives.** MTConnect is machine tools, OPC UA is robotics and
  general machinery, ISO 22400 is the computed KPIs both deliberately exclude. A mixed fleet needs
  all three, which is why the builder offers a choice rather than a migration path.
- **`opcua_vocabulary.node_id` is a browse path, not a numeric NodeId** — `nsu=<ns>;s=<BrowsePath>`.
  The numeric ids live in each spec's NodeSet2 XML, which is not vendored; they were not invented.
  The browse names are transcribed and need confirming against those files.
- **The OPC UA group is derived from the browse path**, not a hardcoded spec→group map — a browse
  path is already `/`-delimited, which is part of why `/` is the metric group separator.
- **The vocabulary uses ISO's terminology.** ISO 22400-2 calls the second OEE factor
  *Effectiveness*, not Performance. `archive/20260101000032_effectiveness_and_mtconnect_semantics.sql` supersedes the catalog's `OEE/PERFORMANCE` with
  `OEE/EFFECTIVENESS` — **deprecate-and-supersede, not a rename**, since `name` is immutable. Both
  rows carry the *same* `semantic_id`: they are two names for one concept, which is why the index
  on `semantic_id` is deliberately not unique. `ISO-22400-OEE-Schema` lists **both** names in
  `properties` so a device still publishing the old one is not flagged `Unmodelled` for doing what
  it was provisioned to do.
- **The vocabulary rename lives in 0030's seed, not in 0032.** Every migration replays on each
  boot, so a 0032 that renamed the row would fight 0030's `ON CONFLICT DO UPDATE` forever —
  re-creating `PERFORMANCE` each boot and then colliding on the rename. 0032 only `DELETE`s the
  stale row for databases that ran the earlier 0030.
- `kpi_id` is the ISO **symbol**, not a clause number — none are asserted, because the standard is
  paywalled and they could not be checked.
- Semantic ids for both are **derived, not issued** — see below.

### Semantic Identity (AAS Phase 1)

`metric_catalog` and `schemas` carry nullable `semantic_id` / `semantic_id_type`
(`20260101000029_semantic_identifiers.sql`). This is Phase 1 of aligning with the Asset
Administration Shell (IEC 63278) **without** adopting its metamodel.

- **`semanticId` is the only part of AAS that carries information this database lacked.** The name
  is a wire contract, the group is a display taxonomy, the MTConnect facets describe behaviour —
  none say which *concept* a metric instantiates. Native `Submodel`/`SubmodelElement` tables would
  be EAV: recursive RLS, a third identifier namespace beside `name`/`sparkplug_id`, and a fourth
  type system beside Sparkplug codes, JSON Schema types and MTConnect units. Two columns buy the
  interoperability; the metamodel buys the cost. If an AAS export layer is built, it reads these.
- **`semantic_id` is deliberately mutable**, unlike `name`/`datatype`. It is an assertion *about*
  the metric and crosswalks get corrected; freezing it would mean deprecating a metric — and
  reconfiguring a device — to fix a typo. The archived `20260101000029_semantic_identifiers.sql` ends with a probe that inserts a row and
  asserts the UPDATE succeeds, so widening `enforce_metric_catalog_immutability()` later fails the
  migration rather than silently making semantic ids unfixable.
- **`semantic_id_type` is CHECK-constrained** to `IRI`/`IRDI`/`ModelReference`, mirrored by
  `SEMANTIC_ID_TYPES` in `utils/standards.js` — same keep-in-step obligation as `sparkplugId.js`.
  Unlike `units`/`standard` this is a closed set in the standard, and a bad value would surface as
  an invalid AAS Reference at export time.
- **Never mint a semantic id that impersonates a standard — the namespace is the honesty
  mechanism.** Every locally-minted id sits under `https://factoryplus.local/semantics/…`, which
  says plainly whose identifier it is. An id under `mtconnect.org` or `iso.org` would assert an
  interoperability that does not exist; a local one is a stable, deterministic handle an AAS export
  can emit today and a single `UPDATE` can replace if a published crosswalk appears. What it does
  not do is make two organisations agree. OPC UA ids are the exception: they are the companion
  spec's own namespace URI plus browse name, derived from something the OPC Foundation does
  publish — but still not a concept URI it registers.
- **MTConnect ids exist at two levels** (`archive/…0032`). `mtconnect_vocabulary.semantic_id` is the
  *concept*, scoped by kind (`…/v2.0/DataItemType/ANGLE`) because a component and a data item type
  could share a name and `(kind, name)` is the table's key. `metric_catalog.semantic_id` is the
  *observation*, built from the whole metric name (`…/v2.0/Axes/C/ANGLE`) because a catalog entry
  is a specific data item on a specific component path — which is what an AAS SubmodelElement
  corresponds to.
- **The MTConnect namespace pins `v2.0`, the major line — not `SCHEMA_VERSION` (2.8).** An id that
  changed every time the vocabulary was regenerated would defeat the point of being stable.
- **Backfills are scoped `WHERE semantic_id IS NULL`.** `semantic_id` is mutable so it can be
  corrected; a migration that re-stamped it every boot would make that impossible. Local extensions
  stay unmapped — `standard` is NULL for them precisely because no standard describes them.
- `mtconnectSemanticId()` in `utils/standards.js` mirrors 0032's SQL expression; the form derives a
  MTConnect id from the composed name and stops the moment the operator types their own
  (`semanticIdManual`), so it can never overwrite a hand-entered crosswalk. It derives nothing
  until a type is chosen — with only a group picked, the composed name names a group, not a metric.
- **The pair is never half-populated.** `api.js` nulls the type when the id is blank, and the form
  refuses to submit a type with no id.

### AAS Export (Phase 3/4)

`supabase/functions/aas-export/` composes an AAS V3 **Environment** for one device and the Devices
tab downloads it (`<device>_aas_v3.json`). It is an *adapter*: nothing upstream knows AAS exists.

- **Telemetry values are never inlined.** The Time Series submodel carries a `LinkedSegment`
  naming the historian endpoint plus an `asset_id` query — which is what IDTA 02008 defines that
  element for. A shell embedding samples would be unbounded.
- **A missing `semanticId` is omitted, never emitted empty.** `semanticReference()` returns
  `undefined` so `JSON.stringify` drops the key; an empty `Reference` is invalid AAS and asserts a
  mapping it cannot name. The unmapped count is returned in `stats` instead, and the UI surfaces it
  as a warning toast.
- **Submodels are split by `metric_catalog.standard`, not by name prefix** — ISO 22400 metrics go
  to `KeyPerformanceIndicators`, everything else to `OperationalTelemetry`. That submodel is
  omitted entirely when empty rather than shipped hollow.
- **`sparkplugToXsd` is duplicated** in `functions/aas-export/sparkplugToXsd.ts` and
  `utils/sparkplugDatatype.js` — an edge worker cannot import the frontend bundle. `test_aas_export.py`
  parses both files and fails on drift, the same discipline `metricGroup.js` has against its SQL.
- **There is no `xs:int32`.** AAS `DataTypeDefXsd` is the XSD built-ins, so Int32 is `xs:int`. An
  invented type name fails at the consumer, not at export — same class of error the
  `semantic_id_type` CHECK exists to prevent. Both mappers and both test suites assert it.
- **Export is allowed to `Operator`/`Auditor` too**, unlike `approve-quarantine`: it is a read.
  Still an allow-list, and still a broader disclosure than any single table — a shell aggregates
  nameplate, config and gateway identity into one payload.
- `AAS_BASE_IRI` and `AAS_HISTORIAN_ENDPOINT` must be declared on the **`supabase-functions`
  service**, not only in `.env` — a worker isolate sees only what `main/index.ts` forwards.

**Conformance is checked against the real IDTA schema** (`tests/schemas/`, vendored verbatim from
`admin-shell-io/aas-specs`, never hand-edited). Validating against it caught three violations the
hand-written structural tests had passed, all of the same shape — *the metamodel expresses "absent"
by omitting the field, never by a placeholder*:

- **`Property.value` is `type: "string"`.** Every value serialises as text whatever `valueType`
  says, so numbers and booleans are invalid — and so is `null`. There is no "exists but unset"
  value; an unpublished metric **omits `value`**. This corrects the opposite decision made when the
  exporter was first written.
- **`SubmodelElementCollection.value` is `minItems: 1`** — an empty collection is invalid, not just
  useless. `collection()` returns `undefined` so it is dropped.
- **`conceptDescriptions` is `minItems: 1`** — the key is omitted rather than emitted as `[]`.

**AASX (`?format=aasx`) is an OPC/ISO 29500 container**, and every part of its discovery chain is
load-bearing: `[Content_Types].xml` → `_rels/.rels` → the deliberately **empty** `aasx/aasx-origin`
marker → `aasx/_rels/aasx-origin.rels` → `aasx/aasenv-root.json`. A reader walks that chain rather
than guessing filenames; drop a link and the package is unreadable. The packaged Environment is
byte-identical to the JSON export, and a test asserts it.

- **The browser cannot fetch AASX through `functions.invoke()`.** supabase-js decodes anything that
  is not JSON or octet-stream as *text*, which corrupts a ZIP. `api.js` builds that request itself
  and asks for a Blob; counts ride back in an `X-AAS-Stats` header because a binary body has
  nowhere to carry them.

### 3D Asset Models (Supabase Storage)

`supabase-storage` runs, serving exactly one bucket: `asset-3d-models`. A device's model becomes an
AAS `File` in a `VisualRepresentation` submodel (`devices.model_3d_path`, `archive/20260101000035_asset_3d_models.sql`).

- **The column stores an object KEY, never a URL.** A stored URL bakes in the origin of whichever
  stack uploaded it and is wrong the moment the deployment moves. The public URL is composed at
  read time from `AAS_MODEL_PUBLIC_BASE` — same arrangement as `AAS_BASE_IRI` and
  `AAS_HISTORIAN_ENDPOINT`, and it **cannot** be derived from `SUPABASE_URL`, which inside compose
  is `http://supabase-kong:8000` and resolves for nothing outside Docker.
- **The bucket is public-read because an AAS `File` URL must be dereferenceable by a viewer holding
  no session**; a signed URL would expire and break every shell already handed out. So anything in
  it is world-readable to whoever learns the path. **Writes are gated on `device:manage`
  (Administrator/Shopfloor_Manager), not on `authenticated`** — an upload changes what a shell
  publishes *and* puts bytes at a public URL, which is exactly that authority. Verified: Operator
  and Auditor are refused by RLS, not merely by a hidden button.
- **The extension is authoritative, never the browser's `File.type`.** No mainstream OS maps `.obj`
  or `.stl`, so they arrive as `application/octet-stream` or as an empty string, varying by
  machine. The bucket must therefore accept octet-stream, which leaves the extension — constrained
  by `model_3d_path`'s CHECK — as the real control, and as what the exporter derives `contentType`
  from. `model3dContentType.ts` mirrors `utils/model3d.js`; `test_aas_export.py` fails on drift.
- **The bucket is created by `scripts/storage-init.mjs`, not by a migration.** storage-api owns the
  `storage` schema and migrates it on boot; the supabase/postgres image ships a stub with no
  `public` column, and `supabase-db-init` replays migrations long before storage-api starts — so a
  migration could create the row but not mark it public, and the bucket would come up private on
  first boot. The policies on `storage.objects` *do* live in 0035; that table exists from the stub
  onward. **storage-api answers both "already exists" and "not found" with HTTP 400**, so the
  script matches on the payload, not the status.
- **`supabase_storage_admin` has no password until `supabase-db-roles-init` sets one.** Without it
  storage-api crash-loops on `28P01` and nothing else reports a problem.
- **The healthcheck must use `127.0.0.1`.** `localhost` resolves to `::1` in that image and
  storage-api binds IPv4 only, so the probe fails against a healthy server.
- **`idShort` is `Model3D`.** The metamodel requires a **leading letter**, so `3DModel` is invalid
  and `_3DModel` does not rescue it. This also fixed `toIdShort()`, which prefixed `_` to
  digit-leading names — wrong for any device called *3-Axis Mill*.
- **AASX bundles the model** under `aasx/files/…` with an `aas-suppl` relationship **from the spec
  part** (`aasx/_rels/aasenv-root.json.rels`), not from the origin, plus a `[Content_Types]`
  Override. `File.value` is rewritten to the part name — the only difference between the packaged
  Environment and the JSON export, asserted by whole-document diff. Bundling is best-effort: a
  fetch failure or a model over `AAS_MAX_BUNDLED_MODEL_BYTES` falls back to the URL rather than
  failing the export.
- **The submodel is omitted when no model is attached** — same rule as an unmapped `semanticId`.
- Upload writes the object *then* the row (a row pointing at nothing exports a dead link; an
  unreferenced object is merely litter) and rolls the object back if the row write fails. Removal
  is the reverse order, for the same reason read backwards.

### i3X Server (CESMII Industrial Information Interoperability eXchange)

`i3x/` is a **conformant i3X 1.0 server over the existing model** — `1.0 Compatible` against
CESMII's official 60-test suite, which CI runs against the live Compose stack. Full detail in
[`i3x/README.md`](i3x/README.md); what belongs here is what constrains work elsewhere.

- **It is a read-side adapter and introduces no new type system.** `schemas.schema_definition` *is*
  an ObjectType (both JSON Schema), `sparkplug_id` *is* an elementId, Unmodelled *is* `isExtended`.
  That is why i3X cost an adapter where AAS cost an exporter plus a metamodel — and why AAS and
  i3X sit side by side rather than competing: **an AAS shell is a document handed over, i3X is a
  live endpoint queried.**
- **It holds its own `spBv1.0/#` subscription, and that is forced, not a preference.** Subscription
  values cannot come from Supabase Realtime for the reason the Realtime section already gives:
  `telemetry`'s rows never reach Supabase's WAL. Everything else in this service is projection;
  this is the part that is real engineering, and it is why the workload exists at all.
- **No service-role key, and `main()` refuses to start if one is in its environment.** Every
  metadata read is a PostgREST request carrying the *caller's* bearer token, so the address space
  is exactly what that caller sees in the dashboard. `ingestion.py` is deliberately **not
  imported** — it builds a service-role client at import time.
- **The MQTT value cache has no RLS**, which is the trap this design must close. Metadata is safe
  because PostgREST enforces policy; the cache is a plain dict keyed by `sparkplug_id`. So a value
  request resolves the requested elementIds through PostgREST *as the caller* first and serves only
  what came back. `validate.py` check 12f pins this.
- **`parentId` is the cell, not the gateway.** i3X gives an Object one parent; a device here has
  two (a cell — where it is; a gateway — how its data arrives). `HasParent` is organizational
  hierarchy, so the cell wins and the data path becomes a `ConnectsVia`/`ProvidesConnectivityFor`
  pair. Collapsing them would make a virtual gateway unrepresentable.
- **Writes are refused**: `PUT /objects/value` answers **405** and `/info` declares
  `update.current: false`. Update is a MAY, so this is fully conformant — *1.0 Compatible* is the
  suite agreeing, not a shortfall. It is also the durable control: the MCP server has an
  `--enable-writes` flag, but that is client-side, and a server that does not implement the verb
  cannot be talked into it. Writes belong on the Sparkplug/NCMD path, where they are audited.
- **One SSE stream per subscription — there is no fan-out in i3X**, and the wait loop `select`s on
  the connection rather than sleeping. HTTP/1.1 keep-alive *serialises* a connection, so a pooling
  client that abandons a stream and immediately issues another request has that request queued
  behind the corpse of the first; that is how the suite's SUB-10 failed, reported as a client
  timeout on an endpoint that was never reached.
- **Two Python 3.10 constraints the container enforces and a 3.12 dev machine hides**, both of
  which have already caused defects here: nested same-type quotes in f-strings are PEP 701 (3.12+),
  and `datetime.fromisoformat` accepts only 3 or 6 fractional digits before 3.11 — PostgREST emits
  trailing-zero-stripped timestamps, so `…11.11239+00:00` parsed locally and failed in CI, silently
  shipping a non-conformant `+00:00` offset. Parse-check Python under `python:3.10-slim`.
- `replicas: 1` with `Recreate`, and it is in `factoryplus.singleWriterWorkloads` for **two**
  reasons: a second MQTT consumer duplicates work, and subscription state is in memory, so a second
  pod 404s a live client depending on which one the Service picks.

### Multi-Submodel Attachment (Phase 5)

`device_submodels` (`20260101000034`) attaches many schemas to one device, one AAS Submodel each.

- **`devices.schema_id` is retained as a fallback, not dropped.** The archived `20260101000021_*` and `20260101000033_*` write it,
  and every reader resolves the union via the `device_schemas` view — join rows, falling back to the
  1:1 column for a device with none. New code reads the join; `schema_id` is the compatibility arm.
- **The modelled set is the union across attachments.** `modelledMetricsAcross()` in `deviceTags.js`,
  mirrored by `modelled_metrics_across()` in `validate.py`. Judging against one schema would flag a
  device for publishing what another of its own submodels accounts for.
- **The derived tag functions accept a schema *or* an array**, so existing single-schema call sites
  stayed correct while the multi-submodel ones pass a list.
- **No immutability trigger, deliberately.** Attaching a submodel is ordinary reconfiguration that
  must stay reversible and changes no wire contract — the opposite of `metric_catalog.name`.
- **The exporter qualifies well-known idShorts once more than one schema is attached**
  (`OperationalTelemetry` → `<SchemaKey>_OperationalTelemetry`), because two schemas on one device
  would otherwise both claim the same idShort. Tests resolve submodels by idShort *suffix* so they
  hold in either configuration.
- `utils/standards.js` is the single source for the `standard` strings; `MTCONNECT_STANDARD` in
  `utils/mtconnect.js` re-exports from it rather than repeating the literal.

### Schema Versioning

`schemas` carries `version` / `parent_schema_id` / `status` / `change_description`
(`20260101000037_schema_versioning.sql`). A published schema is **read-only**; changing one means
forking the next version, editing the draft, and publishing it.

- **Why version at all.** `metric_catalog.name` is immutable because a device is configured against
  that exact string, and a schema says which of those names a device is *expected* to publish.
  Editing one in place silently redefines the contract a fleet is judged against — `deviceTags.js`
  derives Unmodelled by subtraction, so widening or narrowing reclassifies devices with no record
  of what changed. Versioning makes that a dated, described act producing a new row.
- **`fork_schema()` and `publish_schema_version()` are RPCs, not table writes.** `version` is
  computed from the parent and publishing has to repoint every device and archive the predecessor
  in one transaction. `enforce_schema_version_provenance()` rejects a directly-inserted version and
  `prevent_active_schema_mutation()` rejects a directly-flipped status, so **no manual version
  input is possible** — it is a database fact, not a UI convention.
- **The freeze is deny-by-default**: the guard diffs `to_jsonb(NEW)` against `to_jsonb(OLD)` with
  `status` removed, so a column added later is frozen when it exists, not when someone remembers.
- **It binds app-facing roles only** (`authenticated`/`anon`/`service_role`), and that is
  load-bearing. The archived `20260101000019_*`/`20260101000033_*` rewrite seeded schemas by name on every boot, so a guard that
  bound `postgres` would stop db-init the first time anyone published a v2 — the stack would break
  because a user used the feature. The RPCs are `SECURITY DEFINER`, so mutation is *routed*, not
  forbidden. The **status-transition check sits above that bypass** and binds everyone: history
  that can be re-opened is not history.
- **`schema_name` stays UNIQUE and each version gets a derived name** (`Foo` → `Foo_v2`). It cannot
  be relaxed: 0033 uses `ON CONFLICT (schema_name) DO UPDATE`, and 0019/0021/0033 resolve schemas
  with scalar subqueries that would start raising "more than one row" the moment two versions
  shared a name. `schema_version_base_name()` strips a trailing `_v<n>` so suffixes never stack;
  `baseSchemaName()` in `utils/schemaVersion.js` mirrors it, with a CI drift check.
- **Earlier migrations re-pin bindings, and versioning turned that into a boot-time regression.**
  0021 resolved the demo device's schema *by name* and 0033 set `devices.schema_id` to a *pinned
  UUID* — both identify the row that was v1. Publishing a v2 was therefore silently undone on the
  next replay, in its worst shape: `device_submodels` stayed on v2 while `devices.schema_id`
  reverted, and the `device_schemas` view prefers the join rows, so the disagreement was invisible.
  0021 now uses `COALESCE(devices.schema_id, EXCLUDED.schema_id)` (pre-registration, not
  re-provisioning) and 0033 only re-pins a device that has no schema or is still on a superseded
  demo one. **Without both, the pair churned two audit rows per boot** into an append-only table
  while the end state looked correct.
- **`active_schema_version()` plus a reconciliation at the end of 0037 is the general safety net** —
  no binding may reference an archived version while a successor is in force. It works *because
  0037 runs last*: a later migration that re-pins a schema binding must resolve the active version
  itself or re-run the reconciliation. It never forwards onto a **draft** — that would activate an
  unpublished version by the back door — and an archived version with no successor stays put,
  because a stale pointer beats a NULL one that reads as "this device has no model".
- **Publishing moves `devices.schema_id` as well as `device_submodels`.** 0034 keeps the 1:1 column
  as the view's fallback arm; a device provisioned only through it would otherwise stay pinned to
  an archived version and report the new version's metrics as Unmodelled. That UPDATE also fires
  `log_digital_thread_event()`, which is where "what was this machine judged against, and when did
  that change" belongs. A device attached to **both** versions has its redundant old attachment
  dropped first, or the repoint would collide on `uq_device_submodels` and abort the publish.
- **At most one open draft per parent**, by partial unique index — two forks of one parent would
  both claim v2 with nothing to say which one publishing should archive against.
- **`validate.py` seeds its schema fixtures as `draft`**, because check 6d widens a schema in place
  to prove the Unmodelled verdict is derived rather than stored. The guard applies to
  `service_role` too — a trusted key is still not a reason to redefine a live contract.
- The UI renders a published version as a **list, not a disabled form**: offering the shape of an
  edit that the database will reject is worse than not offering it. `isSchemaEditable()` is the
  single predicate, and it **fails closed** on a row whose status could not be read.
- **Download writes `schema_definition` verbatim** as `<schema_name>.schema.json` — no wrapper
  object, no injected `title`, no version banner. A published version is immutable, so the value of
  having the file is diffing it against the database and against the previous version; anything
  added would appear in every one of those diffs as noise that exists nowhere in the schema. The
  version rides on the *filename*, which already carries it because each version has its own
  `schema_name`. It is a **read**, so it is not gated on `schema:manage` — same reasoning as the
  AAS export being open to Operator and Auditor. On a dirty draft it downloads the last *saved*
  state, and the button's title says so. It sits in the row's `ActionMenu` (secondary action,
  keeping the row at two visible controls) but as a visible button in the detail modal, which is
  the screen you are already on when you want the file.

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
  EFFECTIVENESS,QUALITY}`, plus the local extensions `safety_interlock` and `max_temp_threshold`.
  `OEE/PERFORMANCE` is deprecated, superseded by `OEE/EFFECTIVENESS` (`archive/20260101000032_effectiveness_and_mtconnect_semantics.sql`).

`metric_groups` (`20260101000017_metric_group_vocabulary.sql`) is a registry of approved group
**spellings**, not of group membership — membership is always derived from the name. Since 0018 it
is seeded from MTConnect's component types, with `standard` recording provenance.

- The Add Metric form composes the name from a group picker plus the rest of the name; it never
  takes the whole name as free text.
- `enforce_metric_group_spelling()` rejects a group differing only in case from a known one,
  checking the registry **and** groups already in use. It derives the group from `NEW.name`, not
  `NEW.metric_group` — generated columns are computed *after* `BEFORE` triggers, so the latter is
  still `NULL` there. Keep that expression in step with `archive/20260101000016_metric_group.sql` too.
- The picker's vocabulary is `knownGroupNames(registry, catalog)` — the union of both sources.
  Registry casing wins, because that is what the trigger treats as canonical.

### Asset Location

`devices.cell_id` (nullable) plus `location_scope` on devices *and* gateways
(`20260101000036_device_location.sql`) separate **where an asset is** from **how its data gets
here**. `public.device_locations` resolves the effective cell; `utils/cellResolution.js` mirrors it.

- **`device → gateway` is the data path** (in the Sparkplug topic, keys telemetry);
  **`device → cell` is a location overlay** that appears in no topic and no payload. Inheriting
  the second through the first cannot express a virtual gateway (a host-run proxy with no honest
  cell) or a site-scoped asset (BMS, AGV, ambient sensor) that has no single cell at all.
- **NULL means inherit, and `cell_id` has NO default.** Resolution is
  `COALESCE(device.cell_id, gateway.cell_id)`, so an explicit value always *wins* — a default
  makes every value explicit and inheritance unreachable. Ingestion inserts discovered devices
  with no cell and `approve-quarantine` sets `gateway_id`, not `cell_id`, so a default would pin
  every approved device in Unassigned forever. **Inheritance is the absence of a decision.**
- **`ON DELETE SET NULL`, never `CASCADE`.** A device is not a child of its location.
- **Unassigned and Site-Wide are derived lanes, not `cells` rows.** A magic cell would put
  semantics in a free-text `name` (the `devices.asset_type` trap) and the pg_cron purge job runs
  as superuser, past any RLS guard. They are also **different states that must not merge**:
  Unassigned is an absence (a queue that should drain), Site-Wide an operator's assertion (a
  permanent home). That is what `location_scope` records.
- **Scope does not inherit; only `cell_id` does.** A device behind a Site-Wide gateway resolves to
  *Unassigned* — inheriting the connector's scope would answer the question for the operator and
  hide the device from the queue that would have prompted them.
- A **CHECK forbids `site_wide` with a populated `cell_id`** on both tables, so the view's CASE
  can never silently discard a stored value. `api.js` (`locationFieldsFrom`) and
  `approve-quarantine` both clear the cell when the scope is set, so the UI never sees a 400.
- **Ingestion never writes location.** `ingestion/test_device_location.py` pins that across every
  write path; a regression would be silent — devices would just stop inheriting.
- **`/api/v1/cells` returns gateways only.** Membership is the *resolved* cell, which no embed can
  express, and fetching devices there made every consumer read the table twice per refresh
  (Overview polls at 3s). Callers group what they hold with `groupDevicesByCell()`.
- **`device_locations` is read flat and merged by id**, the same shape as `device_schemas`. Mapped
  rows carry `effective_cell_id` (display) *and* `cell_id` (edit) — never collapse the two, or a
  form round-trip converts an inherited cell into an explicit override.
- Adding a column to `gateways` requires calling `ensure_gateway_status_view()` — see migration
  0024's header for why `CREATE OR REPLACE VIEW` cannot widen a `g.*` view in place.

### Device Tags

A device's type is **derived, never stored**: the distinct metric groups its assigned schema models
(`deviceGroupTags`), plus `Unmodelled` when it declared metrics outside that schema. One schema
covering `Robot.*` and `Environmental.*` metrics gives its devices both tags — which is why
multiple schemas per device were not needed.

`Simulated_CNC_01_Schema` (`20260101000033`) is the single default schema, replacing the two seeded
demo ones. It spans all three standards because `devices.schema_id` is 1:1 — a split schema meant a
device could be modelled by MTConnect *or* ISO 22400, never both.

- **It is a superset of the metrics the simulator publishes, deliberately.** Unmodelled is
  *(declared)* − *(modelled)*, so a schema that only held the "interesting" metrics would flag the
  demo device for publishing what it was provisioned to publish. The ISO 22400 and OPC UA entries
  are the converse: modelled but never published, until `node_red_flow.json` is extended.
- **0033 asserts its own invariant** — a `DO` block raises if any metric in the schema is missing
  from `metric_catalog`, deprecated, or has a NULL `semantic_id`.
- **0021 resolves the schema by name, and both it and 0033 guard their writes.** Migrations replay
  every boot; an unguarded `ON CONFLICT DO UPDATE` on `devices` fires `log_digital_thread_event()`
  even when nothing changed, which was appending an audit row per boot before 0033 fixed it.
- `Execution/EXECUTION` is **not** a metric — the concept lives at `Controller/EXECUTION`, which is
  what the simulator publishes and what Grafana and `OverviewTab` read by name.

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

`supabase-realtime` publishes `cells`, `gateways`, `devices` (`0001_baseline_schema.sql` §5).
Tabs subscribe through `hooks/useRealtimeTable.js`; `usePolling` stays at 60s as reconciliation.

- **`digital_thread` was published and is not any more, and the reason is the envelope.** An
  unauthenticated subscriber still receives the change *envelope* — Realtime redacts the payload
  to `{}` and attaches a 401, but the message arrives — so the mere **fact and timing** of a change
  leaks to anyone who can reach the socket. Kong's `key-auth` does not close that: the anon key is
  a registered key necessarily shipped to every browser. The envelope is upstream Realtime
  behaviour and cannot be fixed here, so the available lever is to **publish less**, and the audit
  log was the most sensitive stream in the set (it times quarantine decisions, approvals and
  reconfiguration) while **nothing subscribed to it** — all four consumers subscribe to
  `['cells','gateways','devices']`. Free to remove; the residual asset-edit timing leak is
  accepted, because the dashboard genuinely needs those three live.
  - **This is not an access change.** A publication governs logical replication and nothing else:
    grants and RLS on `digital_thread` are untouched, so `authenticated` and API clients read the
    audit log through PostgREST exactly as before. Verified on a running stack.
  - **The narrowing lives in 0001, not a new migration**, because `ALTER PUBLICATION … SET TABLE`
    is *absolute*: every boot replays 0001 and the next replay drops the table from an existing
    database. A 0010 doing the removal would fight 0001 forever — the 0030/0032 lesson.
  - **0001's own self-check listed the four tables and had to be derived instead.** It asserted
    `relreplident = 'f'` on a hardcoded set including `digital_thread`, so narrowing the
    publication made section 5 and the assertion contradict each other and db-init failed with a
    message about replica identity — naming neither the publication nor the change made. It now
    reads `pg_publication_tables`. Same failure class as the fsGroup constant restated in CI: **a
    check that restates a value rather than reading it is a second source of truth, and it fails
    the day the first one changes.**
- **`telemetry` is unpublishable, not merely unpublished.** `public.telemetry` is a **VIEW** over
  `timescale.telemetry`, which is the `postgres_fdw` foreign table
  (`archive/20260101000010_telemetry_foreign_table.sql`). Either way the rows enter TimescaleDB's
  WAL and never Supabase's. Adding it to the publication does not error — it silently emits
  nothing, which is the worse failure. Do not "fix" the telemetry views by subscribing them.
  - **The foreign table's isolation rests on `PGRST_DB_SCHEMAS`, not on grants**, and this is worth
    knowing before anyone "tidies" it. `authenticated` holds `SELECT` on `timescale.telemetry`
    *and* `USAGE` on the schema, so privileges alone would leave it reachable; what stops it is
    that PostgREST is configured `public,storage,graphql_public`. Verified: `Accept-Profile:
    timescale` is refused with `PGRST106 The schema must be one of the following: …` — an explicit
    refusal by name, not an accident of omission. `anon` reaches neither object.
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
- `VITE_ENABLE_REALTIME` is resolved through `utils/../config.js` — **runtime `/config.js` first,
  build-time inline second**. On the Compose path it is still baked, so flipping it there requires
  rebuilding the frontend image; on Kubernetes it comes from a ConfigMap and flips with a
  `helm upgrade`. See **Frontend Configuration** below.

Four non-obvious container requirements, each of which crash-loops or 403s the service:
`RLIMIT_NOFILE` must be set (its `run.sh` uses it under `set -u`); the `_realtime` schema must
pre-exist (`archive/20260101000022_realtime_schema_bootstrap.sql`); the tenant is `realtime-dev` and `TENANT_NAME` is ignored by
`SEED_SELF_HOST`; and Kong must address it as `realtime-dev.supabase-realtime` because Realtime
resolves the tenant from the leading hostname label. The compose alias and the kong.yml upstream
URL must change together.

### Scheduled Work & Event Dispatch

`pg_cron` (`archive/20260101000025_pg_cron_maintenance.sql`) is **janitorial only** — pruning `net._http_response` and
`cron.job_run_details`, and honouring `auto_delete_at`. No job derives application state.

- **Gateway staleness is a VIEW (`public.gateway_status`, `archive/20260101000024_gateway_status_view.sql`), never a cron writer.**
  `log_digital_thread_event()` fires on every UPDATE to `gateways`, so a sweep writing `STALE`
  would append to an append-only audit table forever, and would be correct only between ticks.
  Keep the 90s threshold in step with `utils/gatewayStatus.js`, same obligation as
  `sparkplugId.js` and `metricGroup.js`.
- **The archive purge honours `auto_delete_at`, not `archived_at` age.** `NULL` means permanent
  retention and the UI says so. Purging on age would destroy rows the user marked to keep.
- `ensure_cron_job()` exists because `cron.schedule()` appends rather than replaces, and
  supabase-db-init replays every migration on every boot.

`pg_net` (`archive/20260101000027_quarantine_webhook.sql`) fires the quarantine webhook. **It is a transition trigger, split
across INSERT and UPDATE — not a hook on `digital_thread` INSERT.** Ingestion stamps
`gateways.last_heartbeat` on every heartbeat, so a blanket hook would emit ~2 HTTP calls/min/
gateway of noise. `TG_OP` cannot appear in a `WHEN` clause (it is PL/pgSQL-only) and `OLD` is
unbound on INSERT, which is why it is two triggers sharing one function.

- pg_net has **no retries, ordering, or DLQ**. Advisory notifications only; use MQTT from the
  ingestion daemon if delivery must be guaranteed.
- `webhook_endpoints` has **no write RLS policy by design** — a writable endpoint table is an
  SSRF primitive. `anon` is revoked at the grant level too.

**Vault** holds only secrets read *from SQL* — in practice `nodered_webhook_jwt_secret`, which
`dispatch_device_quarantine_webhook()` **signs** its outbound pg_net request with (seeded by the
applied `0006_nodered_oidc_auth.sql`),
and `nodered_admin_token`, now break-glass only. `MQTT_PASSWORD` / `DB_PASSWORD` /
`POSTGRES_PASSWORD` stay in `.env`: mosquitto-init and supabase-db need them before the database
accepts connections, and duplicating them would create two sources of truth. The `deploy-nodered`
edge function reads `NODERED_ADMIN_TOKEN` from its own environment, not from Vault — Vault is only
for the SQL-side consumer.

- **The webhook secret is a signing key, not a bearer credential**, and the two must not be
  merged back. See **Node-RED Authentication** below for why sharing the admin token with the
  webhook hands every flow the admin API.

### Telemetry Retention and Compression

`timescaledb/retention.sql` reconciles the hypertable's compression and retention policies on
**every boot**, driven by `TIMESCALE_COMPRESS_AFTER` / `TIMESCALE_RETAIN_FOR` (Compose:
`timescaledb-retention` service; Kubernetes: a `post-install,post-upgrade` hook Job).

- **It moved OUT of `timescaledb/init/` because that directory made the values unchangeable.** The
  postgres entrypoint runs `/docker-entrypoint-initdb.d` **only on an empty data directory**, so an
  operator editing the interval saw no effect on a running stack and had no route to one short of
  destroying the volume — on Kubernetes, deleting the PVC, since a StatefulSet reattaches the same
  claim. A retention interval that can only be chosen before the first row exists is not a setting.
- **It is the operator's decision, and the default is not a recommendation.** `drop_chunks` is a
  hard delete with no undo and nothing copies the chunks first — the backup CronJob does not
  protect what retention already removed. Manufacturing traceability obligations run from weeks to
  decades; 90 days is a starting point no requirement has been applied to. `never` (also `off`,
  `none`, `disabled`) removes either policy.
- **Policies are REMOVED and re-added, never `if_not_exists`.** With a policy already present at a
  different interval, `add_*_policy` emits a notice and does nothing — so a changed setting would
  appear to apply and would not. Removing first is what makes the environment authoritative.
- **The compression `ALTER TABLE` is guarded on current state.** Re-issuing
  `SET (timescaledb.compress…)` with different `segmentby` raises once compressed chunks exist, so
  an unconditional statement would fail the *second* boot of a compressed database.
- **Disabling compression leaves existing compressed chunks compressed.** Decompressing a history
  that may be hundreds of gigabytes, unprompted, during a boot, is not something a config change
  should do; off means "stop compressing new chunks".
- **The values are QUOTED in `.env`, and that is required.** Compose parses `.env` itself and would
  accept a bare `7 days`, but the documented way to run the validator **sources** it
  (`set -a && . ./.env`), where an unquoted value with a space is executed as a command — printing
  `days: command not found` *and* leaving `. ./.env` non-zero, so the rest of the `&&` chain never
  runs. The visible symptom was the validator failing to resolve `timescaledb`, which reads as a
  Docker networking fault. Found by running it, not by review.
- Retention shorter than compression is legal and warns rather than failing: chunks would be
  dropped before ever being compressed, which is almost certainly a mistake but is the operator's
  data doing exactly what the configuration says.
- Still not pg_cron, for the reason the section above gives: telemetry lives in the standalone
  TimescaleDB, and pg_cron reaches it only across the `postgres_fdw` link.

### Node-RED Seeding & Credentials

`scripts/node-red-init.mjs` provisions `/data` on the `nodered_data` volume. It makes **three
writes with three different lifetimes**, and collapsing them behind one guard is what broke the
stack twice: the *flow* is user content (seed once), while *settings.js* and the *credentials* are
stack configuration that must be reconciled on every boot — a volume outlives a fix, and the old
single guard exited before reaching the repair.

- **`flowFile` must be declared in `settings.js`, and its absence is silent.** Node-RED does not
  fall back to `flows.json` — it falls back to **`flows_<hostname>.json`**
  (`@node-red/runtime/lib/storage/localfilesystem/projects/index.js`), and a container's hostname
  is a random id. The seeded `/data/flows.json` is then simply never read: Node-RED opens a blank
  canvas and writes its own empty flow beside ours. The credentials file is derived from the same
  basename, so `flows_cred.json` is missed in the same breath and the broker node comes up with no
  username. One omitted line, two unrelated-looking symptoms.
- **The image SHIPS `/data/flows.json`, so "does it exist" cannot mean "is it provisioned".**
  `nodered/node-red:latest` contains a two-node `Flow 1` placeholder, and Docker pre-populates a
  fresh named volume from the image's directory contents — so the file exists before the init
  script has ever run. Guarding the seed on it meant the repo flow was **never** seeded on a fresh
  stack, while the script announced it was "preserving editor changes" that did not exist. The
  guard is now `/data/.factoryplus-seeded`, which records what the script *did*. Anything it
  overwrites is backed up to `flows.json.pre-seed` first.
- **`_credentialSecret` in `/data/.config.runtime.json` silently defeats the seed.** Node-RED mints
  that key for itself whenever `settings.js` has no `credentialSecret`, and thereafter prefers it:
  it fails to decrypt the seeded file, **discards the credentials**, and rewrites the file empty
  under its own key. The broker node ends up with no username, and Mosquitto — running
  `allow_anonymous false` — refuses the connection with CONNACK 5.
- **Clearing that key is gated on "are there credentials to lose", not on the seed path.**
  Credentials a user entered through the editor really are encrypted under `_credentialSecret`, so
  clearing it while `flows_cred.json` holds content would destroy them. But tying the clear to the
  seed made an already-broken volume unrepairable: the credentials were long gone and the stale key
  survived in a file the script never touched.
- **`settings.js` is checked by LOADING it, not by grepping it.** Node-RED's own default is 26 KB
  and mentions `credentialSecret` in a commented-out example, so a substring test reports a file
  that declares nothing as correctly configured. The previous file is backed up to `settings.js.bak`
  before replacement.
- **Diagnose from the client side, not from Mosquitto's log.** Node-RED logs only a generic
  `Connection failed to broker: <clientId>@<url>` — note that is the *client id*, not the username
  — and Mosquitto's stdout is not a reliable witness here: a connection refused with CONNACK 5 was
  observed with **no** corresponding `not authorised` line, so its absence proves nothing. Settle it
  from inside the Node-RED container, where a two-line probe separates network from auth outright:

  ```bash
  docker exec factoryplus_node_red node -e "
    const mqtt=require('/usr/src/node-red/node_modules/mqtt');
    const c=mqtt.connect('mqtt://mosquitto:1883',{reconnectPeriod:0});
    c.on('connect',()=>{console.log('CONNECTED');c.end()});
    c.on('error',e=>{console.log('ERROR code='+e.code,e.message);c.end()});"
  ```

  `code=5 Not authorized` means the credentials never reached the node — look at `settings.js`,
  `_credentialSecret` and `flows_cred.json`, in that order. A connect failure with no code at all
  is a network or DNS problem instead.

### Grafana SSO

Grafana is an OAuth client of GoTrue's OAuth 2.1 server; `grafana-userinfo` maps
`public.user_roles` → Grafana org role. Five things are load-bearing:

- `GOTRUE_OAUTH_SERVER_ENABLED=true`. The discovery document is served unconditionally, so a
  `200` on `/.well-known/openid-configuration` proves nothing.
- **`api_url` must be exempt from Kong's `key-auth`.** An OAuth client presents client
  credentials, never a Supabase `apikey`, and Grafana has no setting that adds a header to
  `api_url` — so with `/functions/v1/` gated, the userinfo call 401s, Grafana falls back to the
  access token's stock `role: authenticated` claim, and reports
  `[oauth.invalid_role] invalid role: Authenticated` — which reads as an RBAC fault, not a
  gateway refusal. `kong.yml` exempts `grafana-userinfo` and `nodered-userinfo` by **exact path**,
  one service each: `strip_path` removes the whole matched path, so an exact-path route pointing
  at `…:9000/` hands the runtime an empty service name and it answers **400**.
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

### Node-RED Authentication

The generated `settings.js` declares **three independent auth surfaces**, and they are separate
because Node-RED mounts them separately — `adminAuth` guards `httpAdminRoot`, `httpNodeAuth`
guards `httpNodeRoot` (`node-red/red.js:426`). Before this, it declared neither: the editor, the
`/flows` admin API and `POST /hooks/quarantine` were open to anyone who could reach port 1880.

- **`adminAuth.strategy`** — humans, via `passport-oauth2` against GoTrue. **Not
  `passport-openidconnect`**, which always requests `openid` and requires an `id_token` GoTrue
  refuses to sign under HS256; its discovery document also reports `issuer: ""` with relative
  paths. Same OAuth2-not-OIDC arrangement as Grafana, and the same consent prerequisite: the
  user must already be signed in to the dashboard.
- **`adminAuth.tokens`** — services. `deploy-nodered` forwards **the caller's own access token**;
  no shared secret exists on the default stack. Verified as HS256 against `SUPABASE_JWT_SECRET`
  with `aud=authenticated`, then resolved through `nodered-userinfo`. `NODERED_ADMIN_TOKEN`
  remains as opt-in break-glass, empty by default.
- **`httpNodeAuth`** — the `http in` nodes. **A function, not `{user, pass}`**: Node-RED accepts
  Express middleware here, which is what allows a bearer check instead of Basic auth against a
  bcrypt hash.

Load-bearing details, each of which fails in a way that does not look like its cause:

- **`adminAuth.users` receives only a username string; `adminAuth.authenticate` receives the whole
  profile.** The role is resolved in the strategy's `verify` and must ride through `authenticate`
  or it is lost between login and the session Node-RED mints. `authenticate` is variadic because
  the same hook backs the password grant on `POST /auth/token`, which is refused outright.
- **BOTH are required, and they cover different halves.** `authenticate` runs at login;
  **`users` runs on every request after it** — `bearerStrategy` does
  `Tokens.get(token) → Users.get(token.user)` per call, and with no `users` function Node-RED
  falls back to an internal map populated only from a static `users` *array*, finds nothing, and
  401s. The OAuth handshake still completes and `/auth/token` still returns a session, so the
  symptom is **an editor that signs in and then fails everything with no error shown**. The
  machine path is untouched, because `adminAuth.tokens` never goes through `Users.get` — which is
  why a token-based test suite passes while the editor is unusable. Ask `GET /settings` with an
  editor session token, not just `/flows` with a Supabase token.
- **`users` must return `permissions`, not just the username, and the map behind it is
  PERSISTED** (`/data/.factoryplus-editor-users.json`). `runtime/lib/api/settings.js` copies
  `permissions` off that object into the settings the editor reads, and the editor draws a
  **padlock on Deploy** when it is absent. Sessions persist to `/data/.sessions.json` and survive
  a restart; an in-memory map does not — so every `docker compose restart` silently turned a live
  Administrator into a read-only editor while the API would still have accepted the deploy. It is
  not a logout, which would at least be visible. Signing out and back in was the only cure.
- **The last-resort branch still returns a bare `{username}`**, for a session in neither the map
  nor the file: it keeps that session alive rather than logging everyone out, and it is safe
  because the permissions Node-RED *enforces* come from the token's stored scope
  (`bearerStrategy` passes `{scope: token.scope}` and `needsPermission()` reads that), not from
  this object. Such a session renders read-only until the next sign-in. That scope is fixed at
  login, which is why `sessionExpiryTime` is 8h rather than Node-RED's 7-day default.
- **Asserting HTTP status is not enough anywhere in this file.** Both editor defects answered
  `200` on the calls a status-only probe makes — the first 401'd only *after* login, the second
  returned a perfectly healthy-looking `/settings` whose `user` object was missing one key.
  `validate.py` check 7b therefore signs in for real and asserts the `permissions` **value**.
- **`adminAuth.default` must stay absent.** `needsPermission()` runs
  `passport.authenticate(['bearer','tokens','anon'])`; with no default the `anon` arm has nothing
  to return. Setting it reopens the hole wholesale, so `settingsAreCorrect()` treats its presence
  as a broken file rather than a preference to preserve.
- **The webhook token is a capability, not the admin credential.**
  `dispatch_device_quarantine_webhook()` mints a fresh 60-second HS256 JWT per event
  (`aud=node-red-hooks`) with a key held only for signing. A flow author can read
  `msg.req.headers`, so an admin token here would hand every flow the admin API — which is
  remote code execution on the edge host by way of a `function` node.
- **Both `node-red` and `node-red-init` build from `node-red/Dockerfile`.** `settingsAreCorrect()`
  *evaluates* settings.js, which requires `passport-oauth2`; an init container without it
  concludes the settings are wrong and rewrites the file — clobbering `settings.js.bak` — on
  every boot, silently, because that throw is already handled as "unloadable, replace it". If the
  log says `settings.js written` on more than the first boot, this is why.
- **`settingsAreCorrect()` checks the auth keys *and* `factoryplusSettingsVersion`.** Checking
  only that they exist would freeze their contents on every already-deployed volume; bump
  `SETTINGS_VERSION` in `node-red-init.mjs` whenever the generated body changes.
- **The client is registered `client_secret_post`**, unlike Grafana's `client_secret_basic` —
  that is what `passport-oauth2` sends by default, and GoTrue enforces whichever is registered,
  exactly. `NODERED_PUBLIC_URL` feeds both the registered `redirect_uris` and the strategy's
  `callbackURL`, so the two cannot drift; a mismatch is `invalid redirect_uri`.
- Adding an edge function means registering it in `functions/main/index.ts` — the allow-list is
  the one place stating what a function may reach. An unregistered name 404s before a worker
  starts, which reads as "function not found" rather than as a missing entry.

`ingestion/validate.py` check 7 probes all three surfaces from the running stack. It has to be an
end-to-end check: the fix is a runtime property of the assembled stack, and a settings.js
declaring only `adminAuth` would secure `/flows` while leaving the webhook receiver open.

## Deployment Targets

**Kubernetes (k3s) is the primary target; Docker Compose stays the local development and debugging
path.** Both must keep working — `ingestion/validate.py` is the conformance check for either, and
CI runs it against both. The full plan is `docs/kubernetes-migration-plan.md`, the chart is
`deploy/helm/factoryplus/`, and the runbook is `deploy/k8s/README.md`. **All seven phases are
complete** — the whole stack renders, is reachable on `*.<publicBaseDomain>`, and is exercised in CI
against a real k3d cluster.

- **The four hardening features are OFF by default** (`networkPolicy`, `podDisruptionBudgets`,
  `autoscaling`, `backup`): each needs a value the chart cannot infer, and each fails in a way that
  looks like something else. `values-prod.yaml.example` turns them all on.
- **NetworkPolicies declare the flow graph ONCE as edges**; both directions are generated, so allowing
  egress from A while forgetting ingress on B is unrepresentable — CI asserts the symmetry. Two rules
  are load-bearing: **DNS egress on both UDP and TCP 53** (a response over 512 bytes falls back to TCP,
  so UDP-only fails *intermittently*), and **`supabase-db → node-red:1880`** — the quarantine webhook
  goes there **directly**, not through Kong, and pg_net has no retries or DLQ.
- **A PDB is only created when replicas > 1.** `minAvailable: 1` against one pod can never be satisfied
  by an eviction, so `kubectl drain` blocks forever and node maintenance silently stops working.
- **HPAs are refused for single-writer workloads**, not warned about. `factoryplus.validateAutoscaling`
  holds the list; scaling `ingestion` duplicates telemetry, quarantine decisions and append-only audit
  rows with no error at all.
- **Backups keep ownership and privileges in the dump.** RLS policies reference roles by name and the
  scoped roles own objects, so a `--no-owner` dump restores into a database where every policy denies.
  It is a logical dump, not PITR.
- **`extraEgress` has an `extraIngress` counterpart**, and the asymmetry was itself a defect: the
  generated edges only describe flows *between components of this chart*, so a Prometheus scrape has
  no `from` component to name. With no seam, enabling `networkPolicy` silently stopped all scraping,
  and the symptom is a monitoring stack reporting a healthy stack as entirely down. A kubelet-probe
  allow belongs here too — it is an ingress rule, and was previously mis-documented under
  `extraEgress` where writing it would have changed nothing.
- **Still outstanding:** S3 for `supabase-storage` and Postgres HA. Broker TLS and the internal CA
  are done (**Transport Security** below); storage durability and self-monitoring are done
  (**Durability and Self-Monitoring** below).

### Durability and Self-Monitoring

**The 3D model objects are the one thing no dump covers, and the failure is silent.**
`devices.model_3d_path` *is* in the `supabase-db` dump, so restoring the databases alone yields a
fleet of rows pointing at objects that are gone — and the AAS exporter composes that URL from the
key without fetching it, so nothing detects the break until a viewer opens the shell.

- Three routes, in order of preference: a **CSI VolumeSnapshotClass** (no chart setting),
  **Velero** (`supabaseStorage.podAnnotations`), or **`backup.includeStorage`**.
- **Velero's annotation names the POD's volume, which is `data`** — not `storage`, not the PVC
  name, not the bucket. A name it cannot resolve is skipped and **the backup still reports
  success**, which is the same shape of quiet failure as a dump written to a discarded path.
- **`backup.includeStorage` carries a podAffinity onto the storage pod's node**, because the PVC is
  ReadWriteOnce — RWO permits several pods only *within one node*. Without it the Job schedules
  elsewhere and sits `Multi-Attach error for volume`, which reads as a broken volume rather than a
  scheduling rule. Hence off by default: a backup that silently stops running is worse than one
  never enabled.
- A replicated `global.storageClass` must support **RWO and fsGroup remapping** — every PVC is RWO
  and each pod's `fsGroup` is its image's uid, so a class ignoring fsGroup gives "permission denied"
  on a volume that mounts perfectly.

**Only three things in this stack can be scraped, and each was verified against its pinned image**
before a ServiceMonitor was written for it: `grafana` (native, 1250 series), `supabase-kong`
(57 `kong_*` series, but *only* with the plugin **and** the status listener on) and `mosquitto`
(48 `broker_*` series via an exporter sidecar).

- **There is deliberately no `supabase-rest` ServiceMonitor.** PostgREST 12.2.0 exposes no metrics
  at all — its admin server serves `/ready` and `/live` and there is no metrics setting in its
  configuration. One naming it would be fiction: Prometheus would list the target DOWN, or scrape an
  endpoint answering 200 with nothing, and the panels would read as an idle component. It is not a
  real gap — every PostgREST request arrives through Kong, so the gateway's counters already carry
  it labelled per service. **That is why Kong's is the most valuable scrape in the stack**: it is
  the only place the whole HTTP tier can be measured from.
- **`prometheus` must appear in `KONG_PLUGINS` on both targets.** `kong.yml` is shared and declares
  the plugin globally, and naming any plugin in that variable **replaces** Kong's bundled set — so a
  target missing it does not lose metrics, it refuses to boot with `plugin 'prometheus' not
  enabled`, an error naming the config file rather than the env var. CI asserts the three lists
  agree.
- **Mosquitto has no HTTP metrics surface and cannot be given one** — it publishes to `$SYS/broker/#`
  MQTT topics, so the sidecar is an MQTT *client* that re-serves them. **The metrics are prefixed
  `broker_`, not `mosquitto_`**; alerts written against the latter match nothing, silently. The
  sidecar connects over loopback 1883 even under MQTTS: the traffic never leaves the pod, and 8883
  would make it verify a certificate whose SANs name the Service, not `127.0.0.1`.
- **`telemetry.serviceMonitor.labels` decides whether any of it works.** The operator only adopts
  ServiceMonitors matching its `serviceMonitorSelector` (`release: <its release>` by default);
  without a matching label the objects are created, are visible to `kubectl`, and are **ignored** —
  no target, no error, nothing logged.
- **Under `networkPolicy.enabled` every scrape is dropped** unless `extraIngress` admits it, since
  Prometheus is not a component of this chart and so has no generated edge.
- **Grafana is inside the thing being monitored**, so a `supabase-db` failure takes the dashboards
  with it. Scrape into a Prometheus in its own namespace and alert off-cluster.

### Transport Security (internal CA and MQTTS)

**The chart names a cert-manager issuer and never assumes what kind it is**, so an internal CA and
ACME are interchangeable. `deploy/k8s/internal-ca.yaml` creates a self-signed root that boots a
`factoryplus-ca` `ClusterIssuer`.

- **The CA lives OUTSIDE Helm, and must stay there.** It holds the root private key: `helm uninstall`
  would take it, making every certificate ever issued unverifiable and forcing a new root onto every
  machine that trusts this one. It is also cluster-scoped, shared between releases, and a 10-year
  artefact against a monthly chart.
- **The root Certificate goes in `cert-manager`'s namespace, not the app's.** A `ClusterIssuer`
  resolves `ca.secretName` in cert-manager's *cluster resource namespace*. Put it in `factoryplus`
  and the Secret is created perfectly while the issuer reports `secret not found` — every Certificate
  then sits Pending with no events of its own.
- **ACME is not merely unnecessary here, it cannot work.** HTTP-01 needs public inbound, DNS-01 needs
  a public zone plus API credentials, a wildcard requires DNS-01 specifically, and an internal domain
  cannot be validated at all.
- **The TLS edge is browser-only, which is what makes this cheap.** Every service-to-service hop
  stays plaintext on in-cluster Service names — Grafana's `token_url`/`api_url`, Node-RED's token and
  userinfo URLs, `NODERED_URL`, and the pg_net quarantine webhook. So no CA bundle is injected into
  Grafana, Node-RED or the edge runtime. Only `auth_url` is an ingress address, because a browser
  follows it. **The cost is trust distribution**, and it is not cosmetic: the OAuth handshake happens
  in the browser, so a user trained to click through a warning on `api.<domain>` has been trained to
  dismiss exactly the warning that would report an interception.
- **RSA, not ECDSA, for both root and leaf.** A compatibility decision, not a cryptographic one:
  industrial gateways run embedded TLS stacks of varying age, and the failure is a handshake alert on
  a subset of the fleet with nothing useful logged at the broker.

**MQTTS is password auth over TLS, not mutual TLS** (`require_certificate false`). Mutual TLS is a
coherent and better design, but half of it is worse than neither half: `use_identity_as_username`
would replace the password file, and the ACL's `%u` would stop matching the `sparkplug_id` the
provisioning script writes.

- **The 8883 listener is a SEPARATE FILE (`mosquitto-tls.conf`), appended when certificates exist.**
  Mosquitto **exits 1** when `certfile` names a missing file, reporting three lines of raw OpenSSL
  "system library" errors that name neither the file nor the option — so an unconditional listener
  would crash-loop every Compose stack with a log pointing nowhere near the cause.
- **`allow_anonymous`, `password_file` and `acl_file` are declared ONCE in the global section, and
  `password_file` twice is FATAL on 2.0.x** (`Duplicate password_file value`, exit 3) while **2.1.x
  accepts it**. That is not trivia: it took the broker down on both targets when the image was pinned
  from `latest` back to 2.0.20, and nothing in CI read the broker config. Declaring them once is also
  what guarantees all three listeners authenticate identically — nothing above the first `listener`
  can be listener-specific. `scripts/check-broker-config.mjs` now runs the real config on the pinned
  tag and asserts an unauthenticated client is refused; **a config that starts is not a config that
  is safe.**
- **SANs are the thing that goes wrong, and the failure is asymmetric.** Gateways dial the broker by
  **IP**; in-cluster clients use the name `mosquitto`. A certificate with no IP SAN verifies
  perfectly where you test it and fails on every gateway with a mismatch the broker never logs — the
  stack reports healthy, the simulator keeps producing telemetry, and the fleet is off. The chart
  refuses to render a LoadBalancer deployment whose certificate carries no external identity.
- **1883 is not withdrawn when TLS goes on.** A fleet migrates gateway by gateway, so both ports in
  use *is* the normal state; `external.plaintext: false` is the last step, not the first. 1883 is
  never removed from the *in-cluster* Service at all.
- **Renewal needs no restart.** Mosquitto re-reads certificates on `SIGHUP` — verified against
  2.0.20 by swapping the files on a running broker — so the reload sidecar handles renewal with no
  gateway disconnected. Without it the broker would serve the old certificate until it expired, weeks
  after a renewal cert-manager reported as successful.
- **In-cluster clients are opt-in** (`mosquitto.tls.internalClients`) and share one switch, because
  they share a trust domain. The CA is projected **`ca.crt` only**: `mosquitto-tls` is a
  `kubernetes.io/tls` Secret and also holds the broker's private key, which no client should hold.
  Both **fail closed** — a missing CA stops startup rather than degrading to plaintext or to
  unverified TLS.
- **There is no "skip verification" setting anywhere, deliberately.** TLS that does not verify is
  indistinguishable from a successful interception. In Node-RED that trap is one omitted key:
  `addTLSOptions()` ends with an unconditional `opts.rejectUnauthorized = this.verifyservercert`, so
  leaving `verifyservercert` off the `tls-config` node makes it `undefined`, and 10-mqtt.js then
  falls back to the broker node's own value, which **defaults to `false`**. The result is an
  encrypted connection that accepts any certificate, with a happily connected broker in the editor
  and nothing logged. `node-red-init.mjs` sets it on **both** nodes for that reason.

- **CI runs `validate.py` against BOTH targets** — `e2e-validation` on Compose, `k8s-validation`
  in-cluster as a Job. That is the real drift control: there is no way to automate "these two
  topologies describe the same system", and a check claiming to would pass while they diverged.
- **`helm test` is the cheap gate and mutates nothing** — it proves the `postgres_fdw` link (M6).
  Run it before any E2E suite: `public.telemetry` is a foreign-table projection, so a wrong port there
  fails as a *relation-level* error from PostgREST, which reads as a schema fault three layers from
  the cause. `SELECT 1` would prove nothing — the query must cross the wrapper.
- **The E2E Jobs are off by default** (`e2e.enabled`) because they seed and delete fixtures. The AAS
  Job waits on the validate Job **by initContainer, not by CI step order** — `validate.py` approves
  `Simulated_CNC_01`, and without it the AAS suite skips its own subject and reports success.
- **`scripts/check-image-tag-parity.mjs`** asserts both targets pin the same tag, including the one
  coupling a repository-name comparison cannot see: `supabase/functions/Dockerfile` builds `FROM
  supabase/edge-runtime`, which Compose runs directly.
- **`factoryplus.fullname` collapses its prefix** when the release name already contains the chart
  name — release `factoryplus` yields `factoryplus-db-init`, not `factoryplus-factoryplus-db-init`.
  Assuming the doubled form fails late: the install succeeds and the first `kubectl logs` says
  `NotFound`.

- **Browser-facing URLs come from `_helpers.tpl`, never from a literal.** `factoryplus.grafanaUrl`
  feeds the Ingress rule, `GF_SERVER_ROOT_URL`, *and* the `redirect_uris` db-init registers — three
  consumers, one value, so an ingress hostname cannot disagree with what a service advertises or with
  what GoTrue will accept. Same for Node-RED. **A CI check asserts both equalities** plus that no
  browser-facing URL is an in-cluster name and no in-cluster URL is a domain.
- **`global.scheme=https` is mandatory with `ingress.tls.enabled`**, and the chart refuses otherwise:
  the redirect URIs would be `http://` for a site the browser reaches over `https`, which fails as
  `invalid redirect_uri` while every pod reports healthy.
- **Ingress is subdomain-based, and paths are not an option.** Grafana needs `serve_from_sub_path`,
  Node-RED needs both `httpAdminRoot` and `httpNodeRoot` moved — which changes the quarantine
  webhook's path, and that path is *registered in the database* — and Studio has its own basePath
  assumptions.
- **Raw MQTT (1883) is not on the Ingress and cannot be**: it is TCP. `mosquitto-external` is a
  LoadBalancer; only WebSockets (9001) ride the Ingress.
- **Grafana keeps one `grafana.ini` shared with Compose**; only `root_url` and `auth_url` are
  overridden, via `GF_<SECTION>_<KEY>` env vars. `fsGroup` is **472**, not 1000.

- **Four images must be built locally** — they are on no registry: `factoryplus/edge-runtime`,
  `factoryplus/ingestion` (both with the **repository root** as context), `factoryplus/node-red`, and
  `factoryplus/frontend` (with `--build-arg VITE_RUNTIME_CONFIG=true`). See `deploy/k8s/README.md`.
- **`replicas: 1` is a correctness constraint, not a default, for `ingestion`, `node-red`,
  `mosquitto`, `supabase-realtime`, `supabase-storage` and both databases.** Each has its own reason
  and the manifests spell them out; ingestion's is the sharpest — a plain paho subscribe with no
  shared-subscription group means every replica consumes every message, so a second one duplicates
  telemetry, quarantine decisions and append-only audit rows. Those workloads use `Recreate`, so even
  a rolling update never briefly runs two.
- **Gateway MQTT credentials live in the `mosquitto-passwords` Secret**, provisioned by
  `scripts/mosquitto-provision-gateway.mjs --target=k8s`. The script patches the Secret and then
  **forces the reload** — a kubelet refreshes a projected volume on its own 60–90s sync, which would
  otherwise look exactly like a wrong password. A sidecar converges on any change made by another
  route. Never `mosquitto_passwd -b -c` on the merged file: `-c` creates it and discards every
  gateway.

- **The chart validates its own values and fails the render, never the pod.** `_helpers.tpl`
  refuses a partial Supabase credential set, a Realtime key of the wrong length, and any Realtime
  Service name but `realtime-dev`. Each of those otherwise produces a stack that reports healthy
  and refuses every request, or a CrashLoopBackOff naming something other than the cause.
  Validation is invoked from `NOTES.txt` so it runs on every install, upgrade and `helm template` —
  putting it in a resource template would skip the checks whenever that resource was disabled,
  which is when a values file is most likely to be wrong.
- **Helm cannot read files outside its chart**, so repository-owned config the chart must mount is
  mirrored into `deploy/helm/factoryplus/files/` by `scripts/sync-helm-chart-files.mjs`. The copies
  are committed (a packaged chart must install with no build step) and CI runs the script with
  `--check`. Adding a mounted config file means adding it to that script's `MIRRORS`.
- **A `{{- /*` comment straight after a `---` separator corrupts the document** — the `{{-` chomps
  the newline and yields `---apiVersion: v1`. `helm template` emits it happily and `grep '^---'`
  still matches; only `helm lint` catches it. Use `{{/* … */}}` after a separator.
- **Postgres ports in the chart are always 5432.** 5433 and 54322 are docker-compose *published*
  ports, chosen to avoid colliding with a local PostgreSQL; there is no port mapping in Kubernetes.
  CI greps the rendered manifests for them — **scoped to `value:`/`port:` lines**, because the seed
  legitimately carries `postgres://localhost:5433` in `directory_services` as display metadata.
- **Secrets are substituted into config files by an initContainer, never by Helm.** Rendering
  `kong.yml` at template time breaks the `existingSecret` path silently: with the Secret owned
  outside the chart the key values are empty, Helm substitutes empty strings, and Kong registers
  **empty API keys, which `key-auth` accepts** — a gateway that reports healthy with authentication
  off. CI asserts JWTs appear only inside `Secret` objects.
- **`depends_on` maps three ways**: a hook `Job` for shared state (weights 0/10/20 —
  roles-init → db-init → storage-init), an `initContainer` for one pod's own volume, and a wait-for
  loop plus readiness probes for everything else. The hooks are `post-install,post-upgrade`, never
  `pre-` — `pre-upgrade` would run the migrations before the new GoTrue exists, and GoTrue owns the
  `auth` schema they build on.
- **NEVER `helm install --wait` ON A FIRST INSTALL — it deadlocks this chart.** Helm's order is
  *create resources → (with `--wait`) block until every workload is Ready → run post-install
  hooks*. The bootstrap **is** those hooks: `db-roles-init` issues the passwords for
  `authenticator`, `supabase_auth_admin` and `supabase_storage_admin`, and PostgREST, GoTrue,
  Realtime and storage-api each wait for their own role before starting. So `--wait` waits for
  pods that are waiting for the hooks that `--wait` will not run until the pods are ready. It fails
  as `INSTALLATION FAILED: context deadline exceeded` after the full timeout, with `supabase-db`
  perfectly healthy, **no init-hook pod ever created**, and the only real evidence
  `password authentication failed` in the database log — nothing in that points at Helm. Install
  without it and assert readiness afterwards with `kubectl rollout status`; `--wait` on a later
  `helm upgrade` is fine, because the roles already have their passwords.
- **Do NOT set `PGDATA` on `supabase-db`.** That image ships `/etc/postgresql/postgresql.conf` with
  `data_directory = '/var/lib/postgresql/data'` hardcoded and launches the server with it, so
  `PGDATA` steers only the entrypoint: initdb populates and chowns a subdirectory, then the server
  opens the mount root — still root-owned, because fsGroup sets the *group*, never the owner —
  and dies with `data directory … has wrong ownership`. Compose sets no `PGDATA`, so this broke
  Kubernetes only. **TimescaleDB keeps its override**: that image ships no `/etc/postgresql` and
  runs `-D "$PGDATA"`, so there it is honoured end to end. The two templates differ because the
  images do, which is why TimescaleDB came up healthy in the same cluster.
- **Probe the image; do not assume a health path.** `supabase/edge-runtime` has none —
  `/_internal/health` and `/health` both 404 as unregistered function names, `/` answers 400 and a
  real function 401s, and `httpGet` scores all four as failures. It uses `tcpSocket`.

- **Kubernetes Service names are identical to the Compose service names.** In-cluster DNS then
  resolves `http://supabase-kong:8000`, `timescaledb:5432`, `mosquitto:1883` exactly as Docker's
  embedded DNS does, so every compose-internal URL in `grafana.ini`, `kong.yml`, `settings.js` and
  the edge-function environment is unchanged. Do not "tidy" a Service name.
  **`realtime-dev` is the one exception** — Realtime reads its tenant from the leading hostname
  label, so the Service is named for the tenant rather than for the workload.
- **Config files that need secrets are TEMPLATES with `__UPPER_SNAKE__` placeholders**, shared by
  both targets: `supabase/kong.yml` and `grafana/provisioning/datasources/datasources.template.yml`.
  Compose substitutes them with `sed` (`supabase-kong-init`, Grafana's entrypoint); Helm renders the
  same file into a Secret. **Adding a placeholder means adding it to both substituters** — each
  scans for surviving markers and fails loudly, and each skips comment lines, because the templates
  document the convention by name.
- **A deployment's public URLs are psql variables, never literals in the seed.** `NODERED_PUBLIC_URL`
  (applied `0006_nodered_oidc_auth.sql`) and `GRAFANA_PUBLIC_URL` (applied `0002_seed_data.sql`)
  are registered as those clients' `redirect_uris`,
  and the upserts are `DO UPDATE` so a rotated secret reaches an existing database. A hardcoded URL
  there is therefore **rewritten on every boot** — which is how Grafana's sat at `localhost:3002`,
  un-fixable in place, until it was parameterised. Both trim a trailing slash: a value pasted from
  a browser bar yields `//login/generic_oauth`, which fails as `invalid redirect_uri` and reads as
  a Grafana fault. Any future OAuth client registration must follow the same pattern.
- **Three Compose services have no Kubernetes counterpart** and that is by design, not an omission:
  `supabase-kong-init` and Grafana's `sed` entrypoint (Helm templates instead), and the frontend's
  baked build args (a ConfigMap instead).
- **Images are pinned, and both targets must pin the same tag.** Several pins carry a paragraph
  explaining why — `supabase/realtime` and `supabase/storage-api` migrate shared schemas on boot,
  `supabase/studio` is Zod-coupled to a `postgres-meta` version, `nodered/node-red:5.0.2` because
  `settings.js` depends on three internal contracts. Two targets on different tags break precisely
  the couplings those pins exist to hold.
- `supabase/functions/Dockerfile` bakes the functions and `node_red_flow.json` for the Kubernetes
  path. **Its build context is the repository root**, because the flow lives there. Compose keeps
  bind-mounting, for hot-reload.

## Development Commands

### Initial Setup
```bash
npm run setup          # Writes .env with 14 FRESHLY GENERATED credentials
docker compose up --build -d   # Launch full stack (all services)
docker compose down -v         # Clean shutdown + volumes
```

- **`setup.mjs` generates; it no longer copies `.env.example`.** Those are the published Supabase
  demo values, and since Kong runs `key-auth` the anon and service-role JWTs are *gateway API
  keys* — a default install accepted credentials committed to this repository. `--demo` copies
  verbatim and is for CI, which needs identical credentials every run (as does `values-dev.yaml`).
- **The three Supabase values are a SET.** The anon and service-role keys are HS256 JWTs *signed
  by* `SUPABASE_JWT_SECRET`; rotating the secret without re-minting both yields a stack that comes
  up entirely healthy and rejects every request at the gateway. That is why they are minted
  together in one script rather than left to three `openssl` commands.
- **The demo LOGINS are separate and unchanged** — `admin@factoryplus.local` / `factoryplus123`
  come from `supabase/seed.sql`, which `validate.py` authenticates as. Generating those is a
  distinct change with a test-suite dependency.
- The chart **refuses to install the demo JWT secret alongside a public `publicBaseDomain`**;
  local forms (`127.0.0.1`, `localhost`, `192.168.*`, `.local`, `.localhost`, `.internal`) are
  accepted, so CI and a genuine lab are unaffected.

### Frontend Development
```bash
cd frontend
npm run dev         # Start Vite dev server on port 3000
npm run build       # Production build
npm test            # Vitest unit tests
npm run test:cov    # Tests with coverage report
```

**`ingestion/validate.py` must scope every assertion to the run's own entities.** The stack always
has audit rows, telemetry and devices from the demo simulator, so a check that queries a whole table
and asserts "not empty" passes regardless of whether anything was exercised. Its cleanup must also
collect `digital_thread` entity ids *before* deleting the named rows — audit rows key on
`entity_id`, and `entity_type` only ever holds `devices`/`gateways`/`cells`, never a fixture name.

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

**`validate.py` needs `SUPABASE_SERVICE_ROLE_KEY` in its environment but must NOT inherit the
rest of `.env`.** Without the key it seeds nothing and fails a large fraction of its 43 checks in a way that
reads like a schema fault ("no quarantined device reported", "no telemetry records"), with the
real cause one line up: `Service role key: MISSING`. But sourcing `.env` wholesale breaks it a
second way — `MQTT_HOST=mosquitto` and `DB_HOST=timescaledb` are compose-internal names that do
not resolve from the host, and the script's own defaults (`localhost:1883`, `localhost:5433`)
are the correct ones there. Export the key alone, or source `.env` and unset `MQTT_HOST`,
`DB_HOST` and `DB_PORT`:

```bash
set -a && . ./.env && set +a && unset MQTT_HOST DB_HOST DB_PORT
export MQTT_USER="$MQTT_VALIDATOR_USER" MQTT_PASSWORD="$MQTT_VALIDATOR_PASSWORD"
python ingestion/validate.py
```

### Database Migrations

**Squashed to a two-file baseline for the public beta.** `supabase/migrations/` now holds
`0001_baseline_schema.sql` (pure DDL) and `0002_seed_data.sql` (pure DML), auto-applied by
`supabase-db-init` on startup. Add schema changes as a **new** numbered file (`0003_…`).

**BOTH BASELINE FILES REPLAY ON EVERY BOOT — they are idempotent, not skipped**, and the difference
decides whether an edit ever reaches a running deployment. This section previously said they were
"guarded to be no-ops once applied, so editing them reaches a fresh database only", which
`0002`'s own header contradicts in as many words: *"IT IS IDEMPOTENT, because supabase-db-init
replays every /migrations/*.sql on every boot"*, and the reference vocabularies use
`ON CONFLICT … DO UPDATE` precisely so that *"an edit has to reach a database that already
exists"*. Editing `0002` to adopt a newer MTConnect release does reach live databases; believing
otherwise is what made the MTConnect generator's dead output path look acceptable for months.

The reason to add a new file is still sound — a squashed baseline is a snapshot, and threading a
change into 2,000 lines of generated DDL loses the *why* — but it is a reviewability argument, not
a mechanical one.

- **The 38 original migrations are archived, not deleted**, under `supabase/migrations/archive/`
  (the glob `*.sql` does not recurse, so nothing there runs). They are the *reasoning* — why
  `metric_catalog.name` is immutable, why gateway staleness is a view, why the Realtime tenant must
  be addressed as `realtime-dev.supabase-realtime`.
  - **EVERY CITATION IN THIS DOCUMENT NAMES ITS FILE.** It used to say "every `migration NNNN`
    reference points into that directory", which stopped being true the moment applied migrations
    `0003`…`0009` existed: one notation then meant two directories, and two citations were simply
    wrong — the Vault webhook secret and `NODERED_PUBLIC_URL` were both attributed to a
    "migration 0003" that contains neither (they are in the applied
    `0006_nodered_oidc_auth.sql`). A convention that has to be remembered is one that decays, so
    archived files are now written `archive/<full-name>` and applied ones by their real filename.

**The applied migrations, in execution order.** These run; everything under `archive/` does not:

| File | What it adds |
| :--- | :--- |
| `0001_baseline_schema.sql` | All DDL, squashed. Pure structure |
| `0002_seed_data.sql` | All seed rows, incl. the generated MTConnect block |
| `0003_audit_immutability_and_quarantine_rpc.sql` | `digital_thread` append-only trigger; the atomic `approve_quarantined_device()` RPC |
| `0004_drop_gateway_ip_address.sql` | Removes a superseded column |
| `0005_digital_thread_signal_and_attribution.sql` | Audit rows record a real change and a real actor |
| `0006_nodered_oidc_auth.sql` | Node-RED OAuth client, `nodered_webhook_jwt_secret` in Vault |
| `0007_metric_catalog_name_check.sql` | Rejects non-conforming metric names on INSERT |
| `0008_gateway_sparkplug_group.sql` | `gateways.sparkplug_group`, exposed through `gateway_status` |
| `0009_revoke_noop_anon_grants.sql` | Withdraws `anon`'s function grants — see below |

- **`0009` closed a privilege escalation, not just noise.** `public.ensure_cron_job` is
  `SECURITY DEFINER` with no authorisation check, and `0001` granted EXECUTE on it to `anon` — so
  `POST /rest/v1/rpc/ensure_cron_job` answered **204** with nothing but the published anon key,
  scheduling arbitrary SQL as `postgres` (`rolbypassrls`, `rolcreaterole`). `0001`'s ACL block
  contains `REVOKE … FROM PUBLIC` two lines above the `GRANT … TO anon` that undoes it, which is
  why reading the file does not reveal it — **pg_dump records only positive grants**, and the
  privilege reset `0001` added for that reason covers tables and sequences but not functions.
- **`0009` derives its set rather than listing it**, and it must stay that way. A hand-written list
  was wrong within one migration: `enforce_digital_thread_append_only()` is created by `0003`,
  after the list was derived from `0001`. It snapshots what `authenticated`/`service_role` can
  execute, revokes PUBLIC and `anon` across `public`, then restores those two — so a logged-in
  user's effective privilege does not change and only `anon` loses. Its self-check **raises**, so a
  database where `anon` can reach a SECURITY DEFINER function does not come up reporting success.
  `validate.py` checks 13/13a are the second gate, because a regenerated `pg_dump` baseline would
  reintroduce the grant silently.
- **Both files are idempotent, and that is not optional** — db-init replays every `*.sql` on every
  boot and there is no applied-migrations ledger. A raw `pg_dump` baseline installs on the first
  boot and takes the stack down on the second.
- **The squash was verified, not asserted**: a database built from the old chain was diffed against
  one built from the baseline — statement sets, per-table content hashes, and the `anon`/
  `authenticated` privilege set. Three defects surfaced that inspection would not have caught, all
  documented in `archive/README.md`: `SET check_function_bodies = false` is *required* (PL/pgSQL
  resolves `%ROWTYPE` at CREATE time, so `fork_schema()` cannot precede `public.schemas`);
  **pg_dump records only positive grants**, so the chain's REVOKEs vanished and `anon` silently
  regained `GRANT ALL` on every table — hence the explicit privilege reset in `0001`; and
  constraints must be **guarded, not dropped and re-added**, since `DROP CONSTRAINT IF EXISTS
  cells_pkey` fails on any populated database that has foreign keys pointing at it.
- **`0001` ends with a reconciliation** that forwards any device bound to an archived schema version
  onto the active one. It works *because 0001 runs first and nothing after it re-pins*. A later
  migration that re-pins a schema binding must resolve the active version itself or re-run that
  reconciliation.
- The MTConnect vocabulary is still generated, and now **the generator writes the live seed** —
  `0002`'s block between `-- >>> BEGIN GENERATED mtconnect_vocabulary` and its `END` marker.
  Bumping `SCHEMA_VERSION` and re-running therefore reaches a real database, which it did not
  before: the generator used to write its historical path under `archive/`, which `db-init` never
  executes because the glob `*.sql` does not recurse. The documented upgrade procedure was a no-op
  and nothing said so.
  - **The blocker was `semantic_id`,** which the generator did not emit and the old `archive/20260101000032_effectiveness_and_mtconnect_semantics.sql`
    backfilled in a separate pass — splicing its output in would have dropped every semantic id on
    a fresh database. The generator now derives it (`…/v2.0/<Kind>/<name>`, pinned to the **major**
    line, never `SCHEMA_VERSION`), which is what made the seed generable at all.
  - **Regenerating reproduced the committed 598 rows byte-for-byte**, which is what confirms the
    derivation matches 0032's SQL rather than merely resembling it.
  - `scripts/check-mtconnect-seed-sync.mjs` no longer diffs two files. It verifies a **SHA-256
    stamped into the BEGIN marker**, plus the semantic-id form, the category rules and
    `(kind, name)` uniqueness. Comparing two committed artefacts is exactly what let the old check
    pass while neither of them was the one that ran; and re-running the generator in CI would make
    the pipeline depend on raw.githubusercontent.com being reachable.
  - `ON CONFLICT … DO UPDATE SET category` only, still: `category` is upstream fact and should
    reach an existing database, whereas `semantic_id` is an assertion corrected by hand, and
    re-stamping it every boot would make a crosswalk permanently unfixable.

## Authentication & RBAC

### Default Demo Accounts (seeded via `supabase/seed.sql`)
| Email | Role | Access |
|-------|------|--------|
| `admin@factoryplus.local` | `Administrator` | Full CRUD |
| `manager@factoryplus.local` | `Shopfloor_Manager` | Full CRUD |
| `operator@factoryplus.local` | `Operator` | Read-only + telemetry view |
| `auditor@factoryplus.local` | `Auditor` | Digital thread read-only |

### Edge Functions
- `supabase/functions/approve-quarantine/` — Validates role claims
  (`Administrator`/`Shopfloor_Manager`), then calls the **atomic `public.approve_quarantined_device()`
  RPC** (applied `0003`) rather than orchestrating writes itself. It previously made four
  sequential PostgREST requests with no transaction, so a failure part-way left `asset_config`
  pointing at a device that was never merged, or two un-quarantined rows claiming one asset. The
  RPC also takes the caller's `user.id` explicitly: `log_digital_thread_event()` records
  `auth.uid()`, and the service-role JWT carries no `sub`, so **every approval and merge used to be
  logged with `changed_by = NULL`** — the audit trail could not say who admitted a device to the
  network. It re-checks the caller's role against `public.user_roles`, so authorisation does not
  rest on the edge function alone
- `supabase/functions/deploy-nodered/` — Validates role claims before proxying Node-RED flow
  deployments, then **forwards the caller's own access token** to Node-RED's admin API. The
  header is unconditional: attaching it only when `NODERED_ADMIN_TOKEN` was set is what made a
  deploy keep working against an unauthenticated Node-RED
- `supabase/functions/aas-export/` — Composes an AAS V3 Environment for one device (Phase 3);
  read-scoped roles, telemetry referenced not inlined. See **AAS Export** above
- `supabase/functions/grafana-userinfo/` — OIDC userinfo for Grafana's `api_url`; returns the
  standard identity claims plus `role` read from `public.user_roles`, and **omits `role`
  entirely** when unmapped so `role_attribute_strict` refuses the login
- `supabase/functions/nodered-userinfo/` — the same lookup for Node-RED, answering in Node-RED's
  permission vocabulary (`*` / `read`) and omitting `permissions` when unmapped. **Separate from
  `grafana-userinfo` deliberately**: the mapping is an authorisation decision, and one endpoint
  serving both would let a change made for one product's role model silently move the other's

Every function must be registered in `supabase/functions/main/index.ts` — the allow-list that
states what each one may reach. An unregistered name 404s before a worker spawns, and that
allow-list is also **the definition of what an edge function IS**: `check-docs-drift.mjs` derives
the list from it rather than from a directory listing, because a directory is not an endpoint.

- **`_shared/` holds code imported by several functions**, currently `roles.ts` (the RBAC lookup)
  and `cors.ts`. **A worker CAN import outside its `servicePath`** — that scopes what is *booted*,
  not what the module graph may import. This document previously said the opposite, and that claim
  was the stated basis for copying `resolveUserRole` into five functions; it was tested against
  `supabase/edge-runtime:v1.74.2` and is false. Both delivery paths already ship the whole tree
  (Compose bind-mounts `./supabase/functions`, the Dockerfile does `COPY supabase/functions`).
  - It **is** still true for reading FILES at runtime — a different mechanism and a different
    permission — which is why `deploy-nodered` takes the canonical flow through
    `NODERED_FLOW_JSON` rather than off disk.
  - `resolveUserRole` **takes a client rather than building one**, deliberately: three functions
    pass a caller-scoped client so RLS applies, and the two userinfo endpoints pass a service-role
    client because the caller is an OAuth client whose user id is already authenticated. Which
    identity performs the read is a per-function security decision and must stay visible at the
    call site.
  - `sparkplugToXsd` and `model3dContentType` stay duplicated **with the frontend** and keep their
    `test_aas_export.py` drift checks — that boundary is a browser bundle, which `_shared` cannot
    bridge.
- **The functions send no `Access-Control-Allow-Origin`.** The origin policy is Kong's `cors`
  plugin and only Kong's: its `header_filter` *replaces* whatever the upstream sent and it answers
  preflight itself, so the wildcard the functions used to declare never reached a browser. Measured,
  not assumed. Deriving an allow-list here too would create a second statement of one policy — the
  arrangement drift guards exist to survive. Revisit only if the edge runtime is ever exposed
  directly, which it is not on either target (no published port under Compose; ClusterIP behind
  Kong on Kubernetes).

## Frontend Architecture

### Frontend Configuration

`src/config.js` resolves every `VITE_*` setting **runtime first, build time second**, so one image
can serve any environment. `public/config.js` is a shipped no-op placeholder that a deployment
replaces (on Kubernetes, a ConfigMap mounted over `/usr/share/nginx/html/config.js`).

- **Never read `import.meta.env` directly in a component again.** Vite inlines it at build, which
  freezes the value into the image — the thing this layer exists to undo. Go through
  `readSetting()` / `readFlag()`, and add the name to `RUNTIME_SETTING_NAMES`.
- **`BUILD_TIME_SETTINGS` must spell each name out as a static property access.** Vite substitutes
  `import.meta.env.VITE_FOO` *textually*; a dynamic `import.meta.env[name]` is not a substitution
  site and reads `undefined` for everything in a production bundle. `runtimeConfig.test.js` asserts
  the key set matches `public/config.js`.
- **`/config.js` loads from `<head>` as a plain classic script.** A classic script is
  parser-blocking and a `type="module"` script is deferred, so it runs first regardless of
  position — adding `type`, `defer` or `async` silently inverts that and every deployment falls
  back to whatever the bundle baked. It sits in `<head>` because `vite build` injects the bundle's
  own module script there, so the built `index.html` would otherwise read in the opposite order to
  the one it executes in.
- **An unsubstituted `${...}` / `__X__` placeholder counts as absent**, never as a value. A rendered
  but unsubstituted config is worse than an empty one: the client constructs and every request fails
  against a nonsense origin with nothing naming the cause.
- **NGINX serves it `no-store`.** Fixed filename, environment-specific contents — a cached copy
  points a redeployed dashboard at the previous environment's Supabase URL.
- `vite.config.js` fails the build when nothing is configured, **unless `VITE_RUNTIME_CONFIG=true`**.
  That opt-out is what stops the Kubernetes build feeding itself dummy values that would then mask a
  missing ConfigMap instead of surfacing it.

### Key Patterns
- **Lazy-loaded tabs** via React.lazy() for code splitting
- **Custom hooks**: `usePermissions`, `usePolling`, `useToast`, `useTheme`, `useAppRouting`, `useQuarantineAlerts`
- **Permission-based UI gating** via `hasPermission(uuid)` from `usePermissions`
- **Direct Supabase client** at `src/lib/supabaseClient.js`
- **Vitest** configured with globals enabled and jsdom environment
- **Every telemetry query leaves `api.js` with a lower time bound**, supplied by
  `telemetryLowerBound()` when the caller gave none (`TELEMETRY_DEFAULT_WINDOW_MINUTES`, 60).
  `public.telemetry` is a `postgres_fdw` projection and **the wrapper pushes WHERE down but not
  LIMIT**, so `.range()` bounds what Supabase *returns*, never what TimescaleDB *scans and ships* —
  and `ORDER BY time DESC` makes it unavoidable, since the sort cannot begin until every row has
  arrived. No live caller omits a window today; the floor exists so the next one cannot
  reintroduce a fleet-wide scan by leaving out an argument, a mistake that costs nothing to make
  and whose symptom (the database is slow) names nothing about its cause. An explicit `from` is
  honoured verbatim — the floor catches an *absent* bound, never overrules a stated one — and with
  only `to` the window is measured back from `to`, so a historical query does not return empty.
  `telemetryWindow.test.js` pins the property "never unbounded", not the number.
- **Derived state is computed client-side, not stored** — device tags, unmodelled metrics, metric
  grouping, gateway staleness and provisioning overdue all follow the same pattern: a pure function
  in `src/utils/`, unit-tested, with no backend cron and nothing persisted that could go stale.
- **Constrain table cells that hold variable-length data.** `.table-wrap` scrolls horizontally, so
  an unconstrained cell pushes the row's action buttons off-screen. This has bitten the quarantine
  queue twice (the birth payload, then the malformed-identity reason).
- **A popover in a table row must be portalled.** Same cause, third symptom: `.table-wrap` is
  `overflow-x: auto`, so a menu positioned inside the row is *clipped* to a sliver. `ActionMenu`
  renders into `document.body` at `position: fixed`, which means it no longer moves with the row —
  hence closing on scroll and resize rather than trying to follow. Its `z-index` (900) sits under
  `.modal-overlay` (1000) deliberately; a menu floating over an open modal is unreachable.
- **Row actions belong in `common/ActionMenu.jsx`, not in the row.** The Devices cell reached seven
  controls and over half the row's width because each feature added one more button. Keep one or
  two primary actions visible and put the rest in the menu; it also lets a disabled item carry
  *why* ("Requires Admin permissions"), which reads far better than a greyed-out button.
- **`common/TagList.jsx` collapses long tag lists**, with `priority` entries pinned ahead of the
  cut. Both users need that and for the same reason — the entry that matters most is not the one
  that sorts first. Devices: `deviceTagList()` appends `Unmodelled` **last**, so a plain truncation
  hides the only tag that calls for action. Gateways' Connected Devices pins two things — the
  Online/Offline summary (the question the column exists to answer) and any **quarantined** device.
  That column is the more important of the two: its length grows with the *fleet*, not with a fixed
  vocabulary, so it has no natural ceiling at all.
  Entries carry `key` (React identity) and optionally `label` (what the overflow tooltip shows).
  They differ on Gateways, where entries are keyed by device UUID and a tooltip of UUIDs would be
  worse than none.

### Theming
- **Colours come from CSS variables in `App.css`** (`:root` / `[data-theme="light"]`). There is
  no Tailwind in this project.
- **A floating surface needs an opaque background.** The toast is `position: fixed` over arbitrary
  page content, so its `rgba(…, 0.15)` tint was compositing against whatever table was underneath
  and the message became unreadable. The tint is correct — it is the same fill the badges use, and
  `--success-text` / `--danger-text` are calibrated against exactly it — what was missing was
  something to composite *onto*. It now paints the tint as a `background-image` over an opaque
  `background-color: var(--bg-card)`. **Never fold those into the `background:` shorthand**, which
  resets `background-color` and brings the transparency straight back; `themeContrast.test.js`
  asserts both halves.
- **`--danger-text` completes the `-text` trio.** `--danger` is a border/icon tone: it clears AA on
  a bare card but measures 3.94:1 on the 0.15 rose fill the error toast sits on — and the error
  toast is the message a user most needs to read.
- **Do not give `var()` a hardcoded fallback.** The sign-in card rendered white-on-white in
  light mode because it referenced `--text-main` / `--bg-main`, neither of which exists; the
  fallbacks made the typo look correct in dark mode and fail silently in light mode. The real
  names are `--text-primary` / `--bg-base`. `__tests__/authScreenTheme.test.jsx` now asserts
  that every variable referenced in `App.jsx` is one the stylesheet defines.
- Prefer the themed classes (`.card`, `.form-control`, `.form-label`) over inline colour styles.

### Shared Utilities
- `hooks/useRealtimeTable.js` — postgres_changes subscription; debounced, session-gated
- `hooks/useClockTick.js` — network-free re-render for wall-clock-derived state
- `utils/metricGroup.js` — metric name grouping; mirrors the SQL generated column. `composeMetricName()`
  is standard-agnostic and builds every metric name, so all three vocabularies produce names the
  same group derivation reads
- `utils/standards.js` — the standard registry, AAS reference types, semantic-id inference
- `utils/mtconnect.js` — MTConnect vocabulary selectors and name composition
- `utils/iso22400.js` — KPI selectors, families, and the form prefill a KPI implies
- `utils/opcua.js` — ExpandedNodeId parsing, browse-path→group derivation, OPC UA→Sparkplug
  datatype mapping
- `utils/deviceTags.js` — schema-derived device tags and unmodelled-metric detection
- `utils/schemaVersion.js` — version labels, lifecycle predicates and lineage walking; mirrors
  `public.schema_version_base_name()`
- `components/modals/SchemaDetailModal.jsx` — one modal, read-only or draft editor by status
- `components/modals/SchemaForkModal.jsx` — the change-description prompt; asks for no version
- `utils/model3d.js` — 3D model extension/media-type table, path composition and size formatting;
  mirrored by `functions/aas-export/model3dContentType.ts`
- `utils/cellResolution.js` — effective-cell resolution, the two lane sources, `needsCellAssignment`
  and `groupDevicesByCell`; mirrors `public.device_locations`
- `utils/deviceProvisioning.js`, `utils/gatewayStatus.js`, `utils/sparkplugId.js`
- `components/common/Model3DUploader.jsx` — the 3D model dropzone, rendered by `AssetConfigModal`
- `components/common/ActionMenu.jsx` — portalled row-overflow menu (see Key Patterns for why)
- `components/common/TagList.jsx` — collapsing tag list with pinned `priority` entries

### Tab Components
- `OverviewTab` — Asset summary cards, plus the shopfloor map. The **Site-Wide and Unassigned
  lanes stack full-width above the cell grid**, not inside it: they are not cells, and inside the
  grid they reflowed between the bays as cells were added, so the queue moved on every stack.
  Each lists gateways *and* devices — a cell-scoped gateway with no cell is usually *why* the
  devices behind it are stranded. Dropping onto a cell or Site-Wide sets location directly;
  dropping onto **Unassigned clears the override and reports where the device actually landed**,
  because Unassigned is derived and cannot be set. Unassigned collapses to one line when empty
  **while staying a drop target** — an empty queue is exactly when you want to drag into it
- `CellsTab` — Factory cell management. Device membership is grouped from its own `/api/v1/devices`
  load; the cells endpoint no longer carries it
- `GatewaysTab` — Gateway configuration and status. Same row shape as Devices: **Launch UI** and
  **Edit** visible, the rest in an `ActionMenu`, **Restore replacing Edit** on an archived row.
  Launch UI stays prominent because it is the only action that leaves the dashboard, and it is
  omitted rather than disabled when a gateway has no `access_url`
- `DevicesTab` — Device listing. **Quarantined devices render in the onboarding queue banner
  only**; `filteredAssets` excludes `is_quarantined` before every other filter, so no filter
  combination can list one twice. `attentionCount` excludes them for the same reason (the queue
  has its own badge).
  **The row carries two actions, not seven**: Telemetry and Edit stay visible, everything else is
  in an `ActionMenu`. **Restore replaces Edit on an archived row** — it is the only action that
  means anything there, so it is never buried. Adding a device feature means adding a menu item,
  not another button
- `DigitalThreadTab` — Audit trail of all metadata changes
- `TelemetryTab` — Time-series data viewer (connects to TimescaleDB)
- `SchemasTab` — Metric catalog (what devices publish), one **Standard Vocabulary Reference** card
  with a MTConnect / ISO 22400 / OPC UA tab selector (`common/VocabularyPanel` plus a tab descriptor
  per standard from `common/{MTConnect,ISO22400,OPCUA}VocabularyPanel.jsx`), and the schema
  registry. Search text survives a tab switch on purpose. **Building from the catalog is the only
  way to create a schema** — *Register New Schema* was removed because a free-text JSON Schema could
  name metrics with no catalog entry, no standard and no semantic id, and every derived feature
  reads schemas. **Changing one is versioning, not editing**: a published row is read-only and
  carries a single primary action, *Create Version (v{n+1})*, which prompts for a change
  description and forks a draft. Archived versions sit behind a toggle — history interleaved with
  the working set stops the table being a list of schemas; drafts stay visible, because opening one
  is the only way to finish it. The Add Metric form's **Standard** selector decides which
  vocabulary the type picker draws from and what the prefill supplies; switching it clears the
  previous selection, because `standard` is what an AAS export reads to pick a namespace
- `DirectoryTab` — Directory service configuration
- `ArchivesTab` — Soft-deleted records restoration

### Constants
- `src/constants.js` — Permission UUIDs (`PERMISSION_UUIDS`) and role mappings

## Database Schema

### Core Tables
- `cells` — Factory cell/groupings (`name` is still `UNIQUE`; cells are not addressed on the wire)
- `gateways` — Edge gateways linked to cells; `sparkplug_id` generated column, plus
  `location_scope` (`cell` | `site_wide`)
- `devices` — Devices linked to gateways, `is_quarantined` flag; `sparkplug_id` generated column,
  plus `reported_identity` / `quarantine_reason` / `identity_source` for quarantine diagnostics,
  and `last_birth_metrics` / `last_birth_metrics_at` for birth-metric observation (see below),
  plus `model_3d_path` (an object key in `asset-3d-models`, never a URL), and
  `cell_id` / `location_scope` for location (see **Asset Location** above)
- `device_locations` (view) — a device's effective cell, resolved at read time
- `digital_thread` — Auto-populated audit log via triggers
- `documents`, `asset_config`, `schemas`, `directory_services` — Extended metadata.
  `schemas` and `metric_catalog` carry `semantic_id` / `semantic_id_type` (AAS Phase 1), and
  `schemas` also carries `version` / `parent_schema_id` / `status` / `change_description`
  (see **Schema Versioning** above). `schema_name` is still `UNIQUE`, so each version is named
  `<base>_v<n>`
- `mtconnect_vocabulary`, `iso22400_vocabulary`, `opcua_vocabulary` — reference vocabularies.
  Read-only to the app: `SELECT` for `authenticated`, everything else revoked, no write policy
- `roles`, `permissions`, `role_permissions`, `user_roles` — RBAC tables.
  `roles_id_seq` used to be left behind by the seed's explicit ids, so inserting a **new** role
  without naming one failed on `roles_pkey`. `0002_seed_data.sql` now ends with a `setval`, so the
  manual workaround is no longer needed — keep that statement if the seed is ever regenerated
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
- **Kong runs `key-auth`**, so every request through the gateway needs a registered API key — the
  anon or service-role JWT, treated as an **opaque string**, not parsed. Two routes are exempt by
  exact path and one service each: `grafana-userinfo` and `nodered-userinfo`, because an OAuth
  client presents client credentials and has no setting that would add a Supabase `apikey` header.
  A consequence worth knowing when testing: **a validly-signed JWT that is not a registered key is
  refused at the gateway**, so a freshly minted token cannot be exercised against a running stack
  without registering it — which is also exactly why shipping the published demo keys mattered.
- **`mosquitto.acl` confines each MQTT client to its own edge-node subtree** via
  `pattern readwrite spBv1.0/+/+/%u/#`, where `%u` is the connecting username — which constrains a
  client only when its username IS its `sparkplug_id`, hence
  `scripts/mosquitto-provision-gateway.mjs`. The application tier closes the other half:
  `verify_gateway_binding()` in `ingestion.py` rejects a message whose topic does not match the
  device's registered gateway

### MQTT Principals

**There is no shared broker account, and removing it was a security fix rather than tidying.** A
single `factoryplus` principal held `readwrite spBv1.0/#` and was connected as by the ingestion
daemon, the i3X server, the Node-RED simulator and `validate.py` alike — so the credential running
the demo flow could publish `DBIRTH`/`DDATA` for **every machine on the site**. `verify_gateway_
binding()` cannot catch that: a forged message published under a **correctly bound** device
satisfies the binding check by construction. That is the whole reason the broker tier has to exist
separately from the application tier.

Five principals, each with a reason to reach exactly what it reaches:

| Principal | Grant |
| :--- | :--- |
| `factoryplus_ingestion` | `read spBv1.0/#`, `write spBv1.0/+/NCMD/+` |
| `factoryplus_i3x` | `read spBv1.0/#` |
| `gwy100000000000400080000` | the Node-RED simulator, via the `%u` pattern |
| `gwy110000000000400080000` | `validate.py`, via the same pattern |
| `factoryplus_monitor` | `read $SYS/#` |

- **Ingestion's split is exact, not approximate.** Its only `publish()` is the rebirth NCMD
  (`ingestion.py`, `request_rebirth`), so `write spBv1.0/+/NCMD/+` is the whole of what it does —
  and it therefore cannot forge telemetry at all. `+` rather than `#` because an NCMD topic has
  exactly four segments.
- **i3X gets its own read-only account rather than sharing ingestion's.** It refuses writes in code
  (405 on `PUT /objects/value`, `update.current: false`); the durable control is a server that
  cannot be talked into writing, and the broker should be able to make that statement too.
  **On Kubernetes it previously had NO credential at all** — `brokerClientEnv` carries host, port
  and TLS only — so it connected anonymously to a broker running `allow_anonymous false`, came up,
  answered `/info`, and served an address space whose values never updated. Fixed with this split.
- **A pinned UUID is what makes a per-gateway credential issuable in advance**, and it is the whole
  reason `validate.py` could move off the wildcard account. `sparkplug_id` is
  `'gwy' || substr(hex(uuid), 1, 21)` — a pure function of the primary key — so pinning the UUID
  fixes the wire identity before the row exists. `VAL_GW_UUID` = `11000000-…-0001`. **Only the
  GATEWAY is pinned**; devices are still allocated dynamically, because they sit in the fifth topic
  segment which the trailing `#` covers, so the onboarding and quarantine checks still exercise
  genuinely unknown ids. Note the first 21 hex characters are what matter: `…-0002` collides with
  `…-0001`, so never derive a second fixture id by incrementing the last group.
- **The username can never be a friendly name.** The ACL pins the topic's edge-node segment to
  `%u` and `verify_gateway_binding()` requires that segment to be the row's generated
  `sparkplug_id`, so `val_gateway_01` **authenticates perfectly and then has every publish silently
  dropped by the broker**. `factoryplus.validateMqttPrincipals` fails the Helm render on one, and
  `mosquitto-provision-gateway.mjs` rejects it.
- **`factoryplus_monitor` is load-bearing, not hygiene.** The broker's own startup/readiness/
  liveness probes and the Compose healthcheck authenticate as it, so an empty
  `mqttMonitorPassword` leaves the pod permanently NotReady and every workload waiting on the
  broker fails to start — an outage naming neither MQTT nor the setting. The chart refuses to
  render without it.
- **Wildcard SUBSCRIPTIONS are NOT refused, and that is measured.** 2.0.20 grants
  `spBv1.0/+/NCMD/+` with QoS 0 (not 128) even to a client confined by `pattern`, and enforces the
  ACL per message at *delivery*. So the simulator flow and `validate.py` keep their existing
  wildcard NCMD subscriptions: each still receives its own rebirth request and not another node's.
  Narrowing them was considered and rejected — the topic lives in the seeded flow, which is user
  content.
- **`scripts/check-broker-config.mjs` asserts all of this by DELIVERY, not by exit status.** A
  denied publish at QoS 0 exits 0 and tells the client nothing, so a status-based check passes
  vacuously. The first version of that helper made exactly this mistake in a second form: it tested
  whether the subscriber printed anything, and `mosquitto_sub -W` writes `Timed out` to stderr —
  so every negative assertion passed while asserting nothing. It matches the payload now.
- **Changing `MQTT_USER` breaks an existing deployment silently unless the credential is
  reconciled.** `node-red-init.mjs` seeded `flows_cred.json` once and then left it alone, so
  Node-RED went on authenticating as an account that no longer existed and reported only
  `Connection failed to broker: <clientId>@…` — the **client id, not the username**, and no CONNACK
  code, which is the same line a wrong host produces. It now decrypts the stored credential and
  rewrites when the **username** differs; a password changed in the editor is left alone, because
  that is a credential for the same account.
- **`ingestion/validate.py` asserts 43 numbered outcomes** and begins with a preflight that proves
  the owner database connection can actually `DELETE` from `digital_thread` — by doing it inside a
  transaction and rolling back. Connecting proves nothing there: `service_role` connects perfectly
  and is then refused by 0003's append-only trigger, which is the situation that connection exists
  to escape
- **Renaming is safe**: `name` carries no identity (see Asset Identity above). Do not reintroduce name-based lookups — the `isUuid()` format-sniffing that used to guard them has been removed
- **Digital Thread**: PostgreSQL `log_digital_thread_event()` trigger automatically logs INSERT/UPDATE/DELETE on cells, gateways, and devices
- **Cross-platform setup**: `scripts/setup.mjs` uses Node.js fs module (no POSIX shell required)
- **paho-mqtt v1 API**: Ingestion code intentionally uses v1 callback signatures; upgrading to v2 requires migration
