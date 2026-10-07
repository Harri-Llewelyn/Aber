# Standard Vocabularies and Submodel Templates

**All vocabularies described here are built and seeded.** This document is the reference for what
each one is, where its identity was verified, and the constraints that govern adding another.
Adding a vocabulary is a checklist in
[`supabase/README.md`](../supabase/README.md#adding-a-vocabulary).

## What the vocabulary layer covers

The standard vocabulary layer covers the five asset classes on the target pilot shopfloor —
machining tools, robots, AGVs, 3D printers, and a BMS — and adopts IDTA Submodel templates so
exported AAS shells carry published semantic identifiers rather than locally minted ones.

Five standards were added to the original MTConnect and ISO 22400 pair: **OPC 40501-1** (Machine
Tools), **OPC 40540** (Additive Manufacturing), **OPC 40001-4** (Machinery Energy Management),
**PackML** (OPC 30050), and **ASHRAE 223P** — see *Verified identities and namespaces* below for
how each was confirmed, and for the one that was wrong.

Every addition follows the existing **"vocabulary, not catalog"** stance of `mtconnect_vocabulary`,
`iso22400_vocabulary` and `opcua_vocabulary`: reference data describing what a standard *defines*,
kept separate from `metric_catalog`, which records what a device actually publishes.

**A fresh install seeds the vocabularies and leaves the catalog empty.** Every standard semantic id
is there when an operator registers a metric on the Metrics page, and nothing is registered until
they do. A development or demonstration stack can load 44 example metrics drawn from the
vocabularies by setting `dbInit.exampleMetrics: true` in the chart's values, as `values-dev.yaml`
does. They are [`supabase/example-metrics.sql`](../supabase/example-metrics.sql), described in
[`supabase/README.md`](../supabase/README.md#example-metrics).

### Scope boundaries, already settled

- **ISO 22400 KPIs ARRIVE AS PUBLISHED METRICS. This platform does not compute them, and that is
  now settled rather than deferred.** Computing OEE needs planned busy time, planned run time per
  item, and good/scrap disposition. None of those are telemetry, and storing them is what would
  turn this platform into an MES. Do not propose storing schedules, orders or routings.

  **The catalog already says so.** A KPI is registered in `metric_catalog` with its ISO 22400
  semantic id and unit, as the example metrics register `OEE/AVAILABILITY`, `OEE/EFFECTIVENESS`,
  `OEE/QUALITY` and `OEE/OEE` — publishable metrics, declared in a DBIRTH by whatever system
  actually knows the plan, and ingested like any other. A second route that computed the same
  semantic ids in the historian would mean two ways to produce one identity with no way to tell
  them apart.

  **Checked against the registered formulas rather than argued from principle.** Of the eight KPIs
  in `iso22400_vocabulary`, NOT ONE is computable from the 44 example metrics: `A = APT/PBT`
  has no PBT, `E = (PRI × PQ)/APT` has no PRI, `Q = GQ/PQ` has only a total `Controller/PART_COUNT`
  with no quality disposition, and MTBF/MTTR need maintenance records. Moving the arithmetic to
  Grafana or Node-RED does not help — the inputs are missing there too. The constraint is the data,
  not the place.

  **Derived series over what we DO have are fine, and must not borrow these ids.**
  `Controller/EXECUTION` and `Controller/PART_COUNT` support an uptime ratio and a parts-per-hour
  rate. Both are legitimate; neither may carry an ISO 22400 semantic id, because that asserts an
  interoperability claim the computation cannot support. No check enforces this: it is a rule for
  whoever registers the derived metric.
- **AGVs are the one gap the five vocabularies leave, and VDA 5050 does not fill it here.** VDA 5050
  is a complete bidirectional MQTT interface with its own topic tree keyed on
  manufacturer + serialNumber, so it fails the vocabulary test and would introduce a second identity
  path competing with `sparkplug_id`. If AGV telemetry is needed, take only the `state` message's
  scalar fields (`batteryCharge`, `driving`, `paused`, `velocity`, `operatingMode`, `lastNodeId`) as
  a vocabulary and put the protocol in a Node-RED edge adapter republishing to `spBv1.0/#`. The same
  verdict applies to BACnet for the BMS. AGV *position* is telemetry, never `devices.cell_id` —
  writing it there fires `log_audit_trail_event()` on every update.

## Extension points

Adding a standard is additive rather than structural, because of four properties worth knowing
before proposing a change:

- `VocabularyPanel` takes a `tabs` array of descriptors
  ([VocabularyPanel.jsx](../frontend/src/components/common/VocabularyPanel.jsx)) — a standard is one
  descriptor, not a refactor.
- `opcua_vocabulary` is keyed `(companion_spec, name)` (`0001_baseline_schema.sql`), so further OPC
  specs are **seed rows in the existing table**, not new tables.
- The migrations are baked into the `db-init` image (`supabase/db-init/Dockerfile`), so a large
  generated seed costs nothing in Helm's release Secret or a ConfigMap.
- The AAS exporter emits `ExternalReference` / `GlobalReference` for every semantic id and
  **ignores `semantic_id_type`** (`semanticReference()` in
  [`supabase/functions/_shared/aas/shell.ts`](../supabase/functions/_shared/aas/shell.ts)) —
  correct AAS V3 for IRIs and IRDIs alike, so IRDIs export with no code change. `semantic_id_type`
  is validation metadata here, not export input, and it is IRI or IRDI only: `ModelReference` was
  withdrawn by `0145`, because a ModelReference is a typed key chain into a model that one text
  column cannot hold and the exporter cannot emit. The form infers IRDI for any ISO/IEC 11179-6
  shape, the IEC CDD `0112/2///61987#ABA565#009` and an ECLASS pair joined by `/` included.
  **Each id also gets a `ConceptDescription`** in the
  Environment (`buildConceptDescriptions()`, #460), because most resolve nowhere (`aber.local`, an
  operator's IRDI). Its IEC 61360 content carries the concept's name, a definition,
  `metric_catalog.units` as `unit` (MTConnect UnitEnum names as free text; `unitId` is unset) and a
  `dataType` derived from the Sparkplug datatype. The definition is the catalog description only
  when every live metric carrying the id agrees on it: the POSITION metrics describe their own axes,
  so that concept's definition defers to MTConnect instead. A new standard's ids are covered with
  no code change.

## How a vocabulary entry becomes a metric

Three decisions shape every metric the form creates from a vocabulary, whatever the standard:

- **A metric's semantic id names the concept, not the metric.** ISO 22400, OPC UA and 223P take
  the vocabulary row's id. An MTConnect metric takes its data item type's id,
  `…/mtconnect/v2.0/DataItemType/<TYPE>`, so `Axes/X/POSITION` and `Axes/W/POSITION` share one;
  the component path, instance and subType stay in the name and `sub_type` (#457). A custom
  MTConnect type is a local extension and gets no id.

- **`metric_catalog.category` is MTConnect's observation category for every standard.** It is
  CHECK-constrained to `SAMPLE`, `EVENT` or `CONDITION` (or null). MTConnect rows carry their own;
  `utils/opcua.js` translates an OPC UA point (a number is a `SAMPLE`, anything else an `EVENT`,
  and nothing maps to `CONDITION`, because OPC UA models faults as alarms, which are not ingested);
  `utils/iso22400.js` files every KPI as a `SAMPLE`; ASHRAE 223P leaves it null, because a 223P
  concept is a class of thing, not an observation.
- **The Add Metric form offers three Sparkplug datatypes: Double, Boolean and String.** An OPC UA
  integer type (`Int16` to `UInt64`, `Byte`) therefore becomes `Double`, and an unknown or
  specification-defined type becomes `String`, the lossless choice (`sparkplugDatatypeFor()` in
  `utils/opcua.js`). The vocabulary row keeps the type the NodeSet declares.

---

## Source acquisition and citation verification

Every seed is either generated from the authoritative machine-readable source or a transcription
carrying a ⚠ VERIFY block that says what was confirmed. Every identity, namespace URI and version
below was read out of that source, not from prose. Nothing here required a paid document.

### Verified identities and namespaces

The OPC entries were parsed directly from the NodeSet2 XML in
[`OPCFoundation/UA-Nodeset`](https://github.com/OPCFoundation/UA-Nodeset) (branch `latest`): the
`ModelUri`, `Version` and `PublicationDate` attributes are quoted verbatim. The rest were checked
against the IDTA content hub, the ISA/ANSI webstore and the open223 project.

| Standard | Verified identity | Namespace / semanticId base |
|---|---|---|
| Machine Tools | **OPC 40501-1** v1.02.0, 2024-11-01 | `http://opcfoundation.org/UA/MachineTool/` |
| Additive Manufacturing | **OPC 40540** v1.0.0, 2025-02-01 — **not 40450** | `http://opcfoundation.org/UA/AdditiveManufacturing/` |
| Energy | **OPC 40001-4** *Machinery Part 4: Energy Management* v1.00, 2025-11-01 | `http://opcfoundation.org/UA/Machinery/Energy/` |
| Digital Nameplate | **IDTA 02006-3-0-1**, Oct 2025 | `https://admin-shell.io/idta/nameplate/3/0/Nameplate` |
| PackML | **OPC 30050** *OPC UA for PackML* v1.01, 2020-10-08 — **the ISA document is not needed** | `http://opcfoundation.org/UA/PackML/` |
| ASHRAE 223P | ontology `v1.0.0-2026`, **Apache-2.0**; the *standard* is still in public review | `http://data.ashrae.org/standard223#` |

The generator pins the NodeSet paths. Upstream capitalises `NodeSet2` and `Nodeset2`
inconsistently, and the Additive path 404s if you guess it:

```
MachineTool/Opc.Ua.MachineTool.NodeSet2.xml
AdditiveManufacturing/Opc.Ua.AdditiveManufacturing.Nodeset2.xml
Machinery/Energy/Opc.Ua.Machinery.Energy.NodeSet2.xml
PackML/Opc.Ua.PackML.NodeSet2.xml
```

**The correction that matters: OPC 40450 is not Additive Manufacturing.** OPC 40450-1 is *OPC UA for
Joining Systems — Part 1: Base* (tightening, riveting, flow drill fastening, gluing). Additive is
**OPC 40540**. Seeding 40450 would have produced a migration citing a real specification for the
wrong domain — exactly the failure the ⚠ VERIFY discipline exists to prevent, and one that would
have been very hard to spot later because both numbers resolve to genuine OPC documents.

**"OPC UA energy" resolves to two documents, and the Machinery one is seeded.** `OPC 40001-4` is the
Machinery-series part and the right fit, because this codebase already carries OPC 40001 Machinery
and OPC 40010 Robotics. It is built on **OPC 34100** *OPC UA for Energy Consumption Management*
v1.0.1, a joint ODVA / OPC Foundation / PI / VDMA specification, whose namespace
(`http://opcfoundation.org/UA/ECM/`) the Energy model imports. Only `Machinery/Energy` is seeded,
so that `companion_spec` keeps meaning one document; ECM is a dependency, not a vocabulary here.

**PackML is not a paid dependency.** ISA-TR88.00.02-2022 is paywalled, and ISA and OMAC publish no
concept IRIs. The state model is also published as the OPC UA companion specification **OPC
30050**, whose NodeSet carries the full state model and per-state descriptions under the MIT
licence, so PackML is read from a published source rather than transcribed.

**An OPC UA semantic id is derived from a published namespace, not issued.** Every
`opcua_vocabulary` id, generated or hand-written, is the specification's namespace URI plus the
member's browse name, for example
`http://opcfoundation.org/UA/PackML/MachSpeed`. The OPC Foundation publishes the namespace,
not that IRI, and nothing resolves it. MTConnect takes the opposite stance: its ids are minted
under `https://aber.local/semantics/mtconnect/v2.0/`, because an IRI under mtconnect.org would
claim an identifier MTConnect never issued. The `opcua_vocabulary` table comment says the same.

**ASHRAE 223P's ontology declares its own licence.** The standard is in public review, but the
ontology is openly published under Apache-2.0, asserted in-band by the rights holder:

```turtle
<http://data.ashrae.org/standard223/1.0/model/all> a owl:Ontology ;
    dcterms:license <http://www.apache.org/licenses/LICENSE-2.0> ;
    dcterms:rights "Copyright 2026 ASHRAE" ;
    dcterms:rightsHolder "ASHRAE" ;
    owl:versionInfo "v1.0.0-2026" .
```

The artefact pinned is `open223/defs.open223.info` → `ontologies/223p.ttl` (536 KB), version
`v1.0.0-2026`. **Not `open223/Standard223`**: the obvious-looking `standard223-core.ttl` there is a
35-byte placeholder, not the ontology.

### Licences

Every vocabulary comes from an open, machine-readable source whose licence permits redistribution
in a derived work, and every licence was read rather than assumed:

| Source | Licence | Asserted by |
|---|---|---|
| OPC 40501-1, 40540, 40001-4, 30050 NodeSets | OPC Foundation MIT License 1.00 | file header |
| IDTA 02006-3-0-1 Digital Nameplate | free IDTA publication | IDTA content hub |
| ASHRAE 223P ontology | Apache-2.0 | `dcterms:license` in the ontology |

As with MTConnect's Apache-2.0, a licence covers the *vocabulary*, not a conformance claim.

## OPC UA companion specifications

`opcua_vocabulary` holds six companion specifications. OPC 40001 Machinery and OPC 40010 Robotics
are hand-written rows. The four read from NodeSets — OPC 40501 Machine Tools, OPC 40540 Additive
Manufacturing, OPC 40001-4 Machinery Energy and OPC 30050 PackML — are generated by
`scripts/generate-opcua-vocabulary.mjs` into marked blocks in `0002_seed_data.sql`, with their
`metric_groups` rows, and `scripts/check-opcua-seed-sync.mjs` verifies them in CI. The generator
also writes the table's `COMMENT`, naming every specification the seed holds, and the check
recomputes it, so a specification added by hand cannot leave the comment behind.

- **The seed is curated, not dumped.** The NodeSets carry almost no descriptions — MachineTool
  declares 356 variables of which 18 have one, Machinery/Energy has 87 and none — so a bulk
  extraction would have produced hundreds of rows with a NULL description, and `VocabularyPanel`
  searches the tooltip as well as the name. The generator instead *verifies* a curated entry list
  against the NodeSet and reads the datatype from it, failing if an ObjectType, a member or the
  pinned specification version is not what it expects. Each entry names the ObjectType that
  declares the member directly, so the generator never has to walk nested components.
- **The rows live in `0002_seed_data.sql`, not a migration of their own,** beside the hand-written
  `opcua_vocabulary` rows, as the MTConnect generator does with its vocabulary.
- **`companion_spec` spellings follow the existing `OPC 40001 Machinery` shape** and are permanent:
  `enforce_metric_group_spelling()` fixes the first spelling of the matching `metric_groups` rows.
- **`standard` stays `'OPC UA'`**, so no new `STANDARDS` entry was needed in the frontend.

## IDTA Digital Nameplate

Built as archived migration 0011: the `idta_submodel_templates` vocabulary, seeded with all 20 IDTA
02006 v3.0 top-level elements, and a `device_nameplate` table, plus the AAS exporter retrofit and
its tests.

- **Nameplate data lives in `device_nameplate`, not `asset_config`,** though the second was the
  obvious home. `asset_config` is ingestion-owned — `ingestion.py` upserts it from every DBIRTH
  keyed `(asset_id, metric_name)` — so operator-typed values would be indistinguishable from
  device-asserted ones and churned on every rebirth. A dedicated table keeps the provenance
  distinction a nameplate needs.
- **Version 3.0.** 2.0 (`https://admin-shell.io/zvei/nameplate/2/0/Nameplate`) is what much existing
  tooling still emits and 4.0 is in development, but the version is part of the id, so the current
  published release is the defensible choice.
- **`semantic_id_type` varies per row, not per submodel.** Most elements carry IEC CDD / ECLASS
  IRDIs (`ManufacturerName` → `0112/2///61987#ABA565#009`), while a few are admin-shell.io IRIs
  (`UniqueFacilityIdentifier`, and `AddressInformation`, which still points at the **1/0**
  ContactInformations namespace even in the 3.0 template).
- **The exporter already had a Nameplate submodel.** This was a retrofit: the existing one carried
  no semanticId on the submodel or on any property.
- **The submodel deliberately does not claim the IDTA template id.** Element-level identifiers only.
  Naming `https://admin-shell.io/idta/nameplate/3/0/Nameplate` would assert conformance to a
  template whose mandatory elements include an `AddressInformation` collection this platform does
  not model, and a consumer trusting the id would validate the shell against the template and fail.

Values resolve **device-first**, joined on `semantic_id` rather than metric name: where a device
publishes OPC 40001 Machinery `Manufacturer` / `SerialNumber` / `YearOfConstruction`, that is what
the shell reports, and the table fills the gaps.

**The editor is a modal opened from a device's drawer**, an action beside Asset Config,
Documents and the two AAS exports — placed directly above the exports because it is the only entry
there that changes what they contain. It is deliberately *not* on the Schemas page: that page is
entirely type-level (what a metric may be named, what a standard defines), and a nameplate is a
fact about one physical asset.

The form shows fields the device publishes for itself as **read-only, with the device's value**.
That is not a limitation but the point: the exporter prefers a published value, so an editable
field would accept a serial number, save it, and never show it in the shell with nothing on screen
explaining why.

**The Vocabulary page holds the standard reference** (`/vocabulary`), split out of Schemas.
The seam is between things you *do* — the schema registry and the metric catalog, which are this
deployment's state — and things you *look up*, which is the half that grows whenever a standard is
adopted rather than when anyone here decides it should.

**Use still works across the split.** The Vocabulary page hands the Metrics page an *identifier*
(`{ standard, name }`, or `{ standard, companionSpec, name }` for OPC UA, whose vocabulary is keyed
on the pair), and the Metrics page resolves it against the vocabularies it already loads for the
Add Metric form's type picker.
The rules that turn a vocabulary row into a metric therefore stay in one place instead of being
copied onto the new page.

## PackML states and value domains (OPC 30050)

**The vocabulary half**: rows under `companion_spec = 'OPC 30050 PackML'`, a `PackML` metric group,
and a fourth NodeSet in the OPC generator. No new table, no `STANDARDS.PACKML`, no panel, no mirror
module, no i3X entry: the panel sections `opcua_vocabulary` by `companion_spec` already.

- **`standard` stays `'OPC UA'`.** Seeding from OPC 30050 and then labelling the provenance `PackML`
  would assert a source that was not read.
- **The source is OPC 30050, not ISA-TR88.00.02-2022**, and the rows' ⚠ VERIFY says so: a faithful
  OPC UA representation of the TR88 state model, but a different document by a different body.
- **The generator refuses STRUCTURE datatypes.** It used to map any specification-defined DataType
  to `String` on the assumption it was an enumeration — true for MachineTool and Additive, false for
  PackML, which declares `PackMLCountDataType` and four more structures. Sparkplug B has no
  composite type, so flattening one to a string would have produced a row that looks ordinary and
  cannot be published. Enumeration and Structure are told apart by the reverse `HasSubtype`
  reference (`i=29` vs `i=22`), and a structure stops the build.
- **The current PackML state is not in this vocabulary, deliberately.** `CurrentState` belongs to
  the inherited `StateMachineType` rather than to anything OPC 30050 declares, so there is nothing
  to verify against. Its *values* — the 17 TR88 states with their canonical `StateNumber`s — are a
  value domain.

**The value-domain half**: `metric_catalog.permitted_values` (archived migration 0012), the derived
*out-of-vocabulary value* finding in `utils/deviceTags.js`, computed at read time from last
telemetry and stored nowhere, and its wiring into the Devices tab.

**`permitted_values` is not frozen**, which is the opposite of the obvious decision. The argument
for freezing — a device is configured against its value set the way it is configured against its
name — does not survive asking what the column is. `name` and `datatype` are a wire contract: a
device is physically configured against them and changing one re-points historical telemetry.
`permitted_values` is a transcribed assertion about a standard that nothing is configured against —
no device reads it, ingestion never consults it, and no historical row moves when it changes.
Freezing it would mean a mistyped value could only be corrected by deprecating the metric and
re-provisioning every device that publishes it, to fix a string that never left the database. That
is exactly the trade archived migration 0029 already refused for `semantic_id`, in the same table,
for the same reason. Standards also *add* values between editions, so a frozen set would go stale by
the standard's action rather than anyone's mistake. `test_metric_catalog_seed.py` (db lane) fails if a
later edit freezes it, or frees `name` or `datatype`.

## ASHRAE 223P

Built as archived migration 0013: `ashrae223_vocabulary` with **640 concepts** (576 Class, 60
Relation, 3 AbstractClass, 1 Concept), generated by `scripts/generate-ashrae223-vocabulary.mjs`
into a marked block in `0002_seed_data.sql` and guarded by `scripts/check-ashrae223-seed-sync.mjs`,
plus `STANDARDS.ASHRAE223`, `utils/ashrae223.js`, a Vocabulary-page tab and an API route. It is
the one vocabulary here with a table of its own: it is not an OPC UA companion specification, and
filing it in `opcua_vocabulary` would misstate its provenance.

- **Real external IRIs** under `http://data.ashrae.org/standard223#`, the second vocabulary (after
  IDTA) whose `semantic_id` is not locally minted.
- **Pre-publication, and said so.** The concept IRIs come from a pre-publication ontology release, so
  a concept moving before publication is foreseeable rather than a surprise.
- **One `metric_groups` row, not 640.** `enforce_metric_group_spelling()` makes the first spelling
  permanent, so registering a group per concept, for a standard that is not yet published, would
  permanently fix a naming the standard may still change. The group is `BMS`, so a point is
  `BMS/<concept>`: a `Building` group would put the word in the group picker and in device tags,
  where the dashboard says *area* (#456). `check-mirror-drift.mjs` holds the form and the seed to
  the same group.
- **A real Turtle tokeniser, not a regex, and the trap was concrete.** `rdfs:comment` appears inside
  the nested `sh:property [ … ]` blank nodes as a SHACL constraint message, several times per class.
  A scan that found `rdfs:comment` after a subject would have described `s223:Fan` as *"A `Fan` shall
  have at least one outlet using the medium `Fluid-Air`"*. The parser tracks bracket depth and reads
  predicates only at the top level of a subject block.
- **Whitespace is collapsed in descriptions**, because several comments are hard-wrapped in the
  ontology and a newline inside a SQL string breaks the one-statement-per-line shape the digest, the
  seed-sync check and every `git diff` of that file rely on.
- **Only the `s223:` namespace is seeded.** The ontology `owl:imports` QUDT
  (`http://qudt.org/3.2.1/shacl/qudt-all`) for quantity kinds and units. Following it would pull in
  a second vocabulary several times the size, under a licence that would need its own check. Units
  come from MTConnect's `units` vocabulary.
- **Browsable without a BMS adapter.** Per-point tagging over BACnet is the long pole, and the
  vocabulary does not wait for it.

---

## Definition of done — applies to every vocabulary

> Kept here as the authoritative list. The same checklist is reachable from
> [`supabase/README.md`](../supabase/README.md#adding-a-vocabulary).

1. Migration is **idempotent** (`ON CONFLICT … DO UPDATE`); db-init replays it every boot.
2. RLS enabled, SELECT policy for `authenticated`, `REVOKE ALL FROM PUBLIC, anon`, no write policy.
3. `metric_groups` rows registered in the migration, carrying `standard` provenance.
4. `NOTIFY pgrst, 'reload schema'`.
5. A generated seed is generated by a committed script and guarded by a seed-sync check in CI,
   rather than transcribed.
6. Migration header carries a ⚠ VERIFY block naming what was and was not confirmed against the
   source document.
7. Frontend mirror module plus unit tests; check whether `scripts/check-docs-drift.mjs` or
   `scripts/check-mirror-drift.mjs` needs a new pair.
8. `docs/openapi.yaml` updated if any endpoint shape changes.
9. **i3X namespaces follow the semantic ids.** A metric's i3X type is its catalog row, in the
   namespace its semantic id is defined in: local for the ids minted here, the standard's own with
   `?projection=i3X` for OPC UA and ASHRAE 223P (`metric_type_namespace` in
   `i3x/address_space.py`, [`i3x/README.md`](../i3x/README.md#address-space)). Ids under a new
   authority are local there until it gains a case. `TestNamespaces` in `i3x/test_i3x_service.py`
   fails if an advertised URI is unused, or a standard's own is advertised without the suffix.

## Settled decisions worth not relitigating

| Question | Settled answer |
|---|---|
| One `opcua_vocabulary` for six specs, or one table each? | **One** — the PK is already `(companion_spec, name)` |
| Is `permitted_values` frozen like `metric_catalog.name`? | **No.** Nothing is configured against it, and a value set widens between editions; freezing it forces a version event for a non-breaking change. `name` stays immutable |
| Where does nameplate data live? | **`device_nameplate`**, not `asset_config`, which ingestion rewrites from every DBIRTH |
| IDTA templates: own table or rows in `schemas`? | **Own table.** `schemas` is deployment state; templates are reference data |
| PackML as its own standard, or under OPC UA? | **Under OPC UA** (`companion_spec = OPC 30050 PackML`) — it is what the NodeSet was read from, and it avoids a table, a panel and a mirror module |
| Digital Nameplate version | IDTA 02006 **3.0** |
| Seed 223P before the standard is published? | **Yes**, from `223p.ttl` `v1.0.0-2026`, with the migration header stating it is pre-publication |
| Does 223P follow the QUDT import? | **No** — separate vocabulary, separate licence, and units are already covered |
| Is OPC 34100 (ECM) seeded too? | **No** — only Machinery/Energy; ECM is recorded as a dependency |
| Which `category` does a non-MTConnect metric get? | MTConnect's: `SAMPLE`, `EVENT` or `CONDITION`, translated per standard; 223P leaves it null |
| Which datatypes can the form create? | Double, Boolean and String; OPC UA integers become Double |
| Which group do 223P metrics file under? | **`BMS`**, the one group registered under ASHRAE 223P (#456) |
| Should the platform COMPUTE ISO 22400 KPIs? | **No.** They arrive as published metrics — the `OEE/*` rows in `metric_catalog` are that route. Not one of the eight registered formulas is computable from the catalogued metrics, and moving the arithmetic to Grafana or Node-RED does not change that. Was a roadmap item; retired |
