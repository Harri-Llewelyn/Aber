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
  *Effectiveness*, not Performance. `0032` supersedes the catalog's `OEE/PERFORMANCE` with
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
  reconfiguring a device — to fix a typo. Migration 0029 ends with a probe that inserts a row and
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
- **MTConnect ids exist at two levels** (`0032`). `mtconnect_vocabulary.semantic_id` is the
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
AAS `File` in a `VisualRepresentation` submodel (`devices.model_3d_path`, migration 0035).

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

### Multi-Submodel Attachment (Phase 5)

`device_submodels` (`20260101000034`) attaches many schemas to one device, one AAS Submodel each.

- **`devices.schema_id` is retained as a fallback, not dropped.** Migrations 0021 and 0033 write it,
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
  load-bearing. Migrations 0019/0033 rewrite seeded schemas by name on every boot, so a guard that
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
  `OEE/PERFORMANCE` is deprecated, superseded by `OEE/EFFECTIVENESS` (migration 0032).

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

**Vault** holds only secrets read *from SQL* — in practice `nodered_webhook_jwt_secret`, which
`dispatch_device_quarantine_webhook()` **signs** its outbound pg_net request with (migration 0003),
and `nodered_admin_token`, now break-glass only. `MQTT_PASSWORD` / `DB_PASSWORD` /
`POSTGRES_PASSWORD` stay in `.env`: mosquitto-init and supabase-db need them before the database
accepts connections, and duplicating them would create two sources of truth. The `deploy-nodered`
edge function reads `NODERED_ADMIN_TOKEN` from its own environment, not from Vault — Vault is only
for the SQL-side consumer.

- **The webhook secret is a signing key, not a bearer credential**, and the two must not be
  merged back. See **Node-RED Authentication** below for why sharing the admin token with the
  webhook hands every flow the admin API.

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
rest of `.env`.** Without the key it seeds nothing and fails ~12 of 20 checks in a way that
reads like a schema fault ("no quarantined device reported", "no telemetry records"), with the
real cause one line up: `Service role key: MISSING`. But sourcing `.env` wholesale breaks it a
second way — `MQTT_HOST=mosquitto` and `DB_HOST=timescaledb` are compose-internal names that do
not resolve from the host, and the script's own defaults (`localhost:1883`, `localhost:5433`)
are the correct ones there. Export the key alone, or source `.env` and unset `MQTT_HOST`,
`DB_HOST` and `DB_PORT`:

```bash
set -a && . ./.env && set +a && unset MQTT_HOST DB_HOST DB_PORT
python ingestion/validate.py
```

### Database Migrations

**Squashed to a two-file baseline for the public beta.** `supabase/migrations/` now holds
`0001_baseline_schema.sql` (pure DDL) and `0002_seed_data.sql` (pure DML), auto-applied by
`supabase-db-init` on startup. Add schema changes as a **new** numbered file (`0003_…`) — the two
baseline files are guarded to be no-ops once applied, so editing them reaches a fresh database only.

- **The 38 original migrations are archived, not deleted**, under `supabase/migrations/archive/`
  (the glob `*.sql` does not recurse, so nothing there runs). They are the *reasoning* — why
  `metric_catalog.name` is immutable, why gateway staleness is a view, why the Realtime tenant must
  be addressed as `realtime-dev.supabase-realtime`. **Every `migration NNNN` reference in this
  document points into that directory.**
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
- The MTConnect vocabulary is still generated, but now lives inside `0002`. The generator writes to
  its historical path in `archive/` and `scripts/check-mtconnect-seed-sync.mjs` compares the
  `(kind, name, category)` triples against the seed. **The generator cannot simply write the seed
  section** — it emits no `semantic_id`, which the old migration 0032 backfilled separately, so
  splicing its output in would silently drop every semantic id on a fresh database.

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
states what each one may reach. An unregistered name 404s before a worker spawns.

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
- **Renaming is safe**: `name` carries no identity (see Asset Identity above). Do not reintroduce name-based lookups — the `isUuid()` format-sniffing that used to guard them has been removed
- **Digital Thread**: PostgreSQL `log_digital_thread_event()` trigger automatically logs INSERT/UPDATE/DELETE on cells, gateways, and devices
- **Cross-platform setup**: `scripts/setup.mjs` uses Node.js fs module (no POSIX shell required)
- **paho-mqtt v1 API**: Ingestion code intentionally uses v1 callback signatures; upgrading to v2 requires migration
