# Standard Vocabularies and Submodel Templates

**All vocabularies described here are built and seeded.** This document is the reference for what
each one is, where its identity was verified, and the constraints that govern adding another.
Adding a vocabulary is a checklist in
[`supabase/README.md`](../supabase/README.md#adding-a-vocabulary).

## What the vocabulary layer covers

The standard vocabulary layer covers the five asset classes on the target pilot shopfloor —
machining tools, robots, AGVs, 3D printers, and a BMS — and adopts IDTA Submodel templates so
exported AAS shells carry published semantic identifiers rather than locally minted ones.

Six standards were added to the original MTConnect and ISO 22400 pair: **OPC 40501-1** (Machine
Tools), **OPC 40540** (Additive Manufacturing), **OPC 40001-4** (Machinery Energy Management),
**PackML** (OPC 30050), **ASHRAE 223P**, and **VDA 5050** (AGVs) — see *Verified identities and
namespaces* below for how each was confirmed, and for the one that was wrong.

Every addition follows the existing **"vocabulary, not catalog"** stance of `mtconnect_vocabulary`,
`iso22400_vocabulary` and `opcua_vocabulary`: reference data describing what a standard *defines*,
kept separate from `metric_catalog`, which records what a device actually publishes, and the derived
metrics Aber computes from those. A name a device declares that the catalog does not record yet is
listed on the Metrics page's Uncatalogued tab (`uncatalogued_metrics`, 0189).

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

  **Checked against the formulas OPC 40501-1 publishes rather than argued from principle.** The
  four OEE KPIs are the ones with a published source ([below](#iso-22400-and-its-source)): Annex C.2.4
  gives `Availability = APT / PBT`, `Effectiveness = PRI x PQ / APT` and `Quality rate = GQ / PQ`,
  and OEE as their product. None is computable from the 44 example metrics. **Availability and
  effectiveness are missing inputs the machine does not have:** `A` needs planned busy time (PBT)
  and `E` needs planned run time per item (PRI). The annex says these "usually come from an MES or
  ERP and not from the machine". **Quality is missing only a disposition the example set lacks,
  not one no machine can give.** `Controller/PART_COUNT` in the examples is a total. But MTConnect's
  `PART_COUNT` with sub type `GOOD` (items that conform to specification or expectation) and OPC
  40501-1's `PartsGood` are both seeded, so a machine that publishes `GOOD` and `ALL` supplies both
  of `Q = GQ / PQ`'s inputs. OEE needs all three factors, so it needs PBT and PRI as well. Moving
  the arithmetic to Grafana or Node-RED does not help — the planned inputs are missing there too.
  The constraint is the data, not the place. The other four rows, `UTILIZATION`, `SCRAP_RATIO`, `MTBF`
  and `MTTR`, are deprecated ([below](#iso-22400-and-its-source)): `MTBF` and `MTTR` would need
  maintenance records.

  **Derived series over what we DO have are fine, and must not borrow these ids.**
  `Controller/EXECUTION` and `Controller/PART_COUNT` support an uptime ratio and a parts-per-hour
  rate. Both are legitimate; neither may carry an ISO 22400 semantic id, because that asserts an
  interoperability claim the computation cannot support. A derived metric is a catalog row with its
  definition on it, added on the Derived tab of the Metrics page, and the database refuses to save
  one with a semantic id or a standard. The checks are in
  [A derived metric is a catalogue row](../supabase/README.md#a-derived-metric-is-a-catalogue-row-0267).
  Its values are computed when they are read, by `derived_series()`, and nothing is stored
  ([how](../supabase/README.md#history-draws-a-derived-metric-from-the-minutes-0282)).
- **AGVs have a vocabulary, from VDA 5050's `state` message, and the protocol is still not Aber's.**
  VDA 5050 is a complete bidirectional MQTT interface with its own topic tree keyed on
  manufacturer + serialNumber, so as a whole it fails the vocabulary test and would introduce a
  second identity path competing with `sparkplug_id`. What is taken is the `state` message's scalar
  fields that are readings: 24 of them, generated from the JSON Schema the VDA publishes under MIT
  (tag 3.0.0) into `vda5050_vocabulary` ([below](#vda-5050-agvs)). Version 3.0.0 renamed the fields
  the 2.x documents use: the battery level is `powerSupply.stateOfCharge` (it was `batteryCharge`),
  the position is `mobileRobotPosition` and the emergency stop `safetyState.activeEmergencyStop`.
  3.0 also calls the vehicle a mobile robot. The protocol itself would go in a Node-RED edge adapter
  republishing to `spBv1.0/#` (#307), which is not built. The same verdict applies to BACnet for the
  BMS. AGV *position* is telemetry, never `devices.cell_id` — writing it there fires
  `log_audit_trail_event()` on every update. Where an asset is belongs to the place model (#321).

## Extension points

Adding a standard is additive rather than structural, because of four properties worth knowing
before proposing a change:

- `VocabularyPanel` takes a `tabs` array of descriptors
  ([VocabularyPanel.jsx](../frontend/src/components/common/VocabularyPanel.jsx)) — a standard is one
  descriptor, not a refactor. A tab whose rows the page does not hold carries a `panel` instead, an
  element that loads its own data: the Imported tab is one.
- **A site adds a vocabulary of its own as rows, not code.** The Administrator imports the AAS
  ConceptDescriptions of a file (*Site vocabularies*, below) into `site_vocabularies` and
  `site_vocabulary_concepts` (`0306`). The seeded tables stay generated and unwritable, and
  `concept_definitions` has an arm that shows an imported vocabulary only once an Administrator has
  confirmed that its definitions may be shared.
- `opcua_vocabulary` is keyed `(companion_spec, name)` (`0001_baseline_schema.sql`), so further OPC
  specs are **seed rows in the existing table**, not new tables.
- The migrations are baked into the `db-init` image (`supabase/db-init/Dockerfile`), so a large
  generated seed costs nothing in Helm's release Secret or a ConfigMap.
- The AAS exporter emits `ExternalReference` / `GlobalReference` for every semantic id and
  **ignores `semantic_id_type`** (`semanticReference()` in
  [`supabase/functions/_shared/aas/shell.ts`](../supabase/functions/_shared/aas/shell.ts)) —
  correct AAS V3 for IRIs and IRDIs alike, so IRDIs export with no code change, and so do OPC UA
  ExpandedNodeIds, which the IDTA and OPC Foundation mapping also writes as `GlobalReference`
  values. `semantic_id_type` is validation metadata here, not export input, and it is IRI, IRDI or
  ExpandedNodeId only: `ModelReference` was withdrawn by `0145`, because a ModelReference is a typed
  key chain into a model that one text column cannot hold and the exporter cannot emit. The form
  infers IRDI for any ISO/IEC 11179-6 shape, the IEC CDD `0112/2///61987#ABA565#009` and an ECLASS
  pair joined by `/` included, and ExpandedNodeId for `nsu=<namespace URI>;i=<id>`.
- **A metric can carry further semantic ids.** A concept often has several published ids, and
  `metric_catalog.semantic_id` holds the one the metric was named from. The others are rows of
  `metric_semantic_ids` (`0299`), each with its own type from the same three and an optional
  source, at most ten a metric and none equal to its own id. The exporter writes them as the
  Property's `supplementalSemanticIds`, beside the `semanticId`, through the same
  `semanticReference()`, and a ConceptDescription for each. So a site whose submodel template names
  a quantity by an ECLASS IRDI adds that IRDI to a metric named from an OPC UA ExpandedNodeId, and
  keeps both. The metric's own id stays primary: the REST API, i3X and a schema's metric list read
  it, and the `metric_semantic_id_crosswalk` view answers which metric carries a concept, across
  both. Making a template's element id the primary one inside a schema built from that template is
  Build Schema from Template's rule, not this table's.
  **Each id also gets a `ConceptDescription`** in the
  Environment (`buildConceptDescriptions()`, #460), because most resolve nowhere (`aber.local`, an
  operator's IRDI). Its IEC 61360 content carries the concept's name, a definition,
  `metric_catalog.units` as `unit` (MTConnect UnitEnum names as free text) and, where the name maps
  to a QUDT unit, `unitId`, a reference to it ([QUDT](#qudt-quantity-kinds-and-units)), and a
  `dataType` derived from the Sparkplug datatype. **The definition is the vocabulary's own text**
  wherever one defines the id. `concept_definitions` (`0169`, redeclared by `0301`, `0302` and
  `0304`) unions the IDTA, ASHRAE 223P, QUDT, OPC UA, ISO 22400, MTConnect and VDA 5050
  descriptions, in that order of precedence. So a 223P class such as `TemperatureSensor` is defined
  by 223P, not by the description of a metric carrying it. A QUDT quantity kind is defined by
  QUDT's own description of it. An MTConnect data item type is defined by the text MTConnect
  publishes for it: POSITION is "point along an axis in a cartesian coordinate system.", not the
  description of whichever axis a metric names. A VDA 5050 field is defined by the schema's
  description of it. An id no vocabulary holds but a known authority issues defers to that
  authority, whatever the metrics carrying it say: a QUDT quantity kind the seed leaves out, such as
  a deprecated one, is defined as, for example, "Temperature, as QUDT defines it."
  (`ID_AUTHORITIES` in `shell.ts`, one entry per authority). Any other id, such as one an
  Administrator typed, takes the catalog description only when every live metric carrying the id
  agrees on it. A new standard's ids are covered with no code change; its definitions need an arm
  in the view.

## How a vocabulary entry becomes a metric

Three decisions shape every metric the form creates from a vocabulary, whatever the standard:

- **A metric's semantic id names the concept, not the metric.** ISO 22400, OPC UA and VDA 5050 take
  the vocabulary row's id, and 223P, a reference here, gives none. An MTConnect metric takes its data
  item type's id,
  `…/mtconnect/v2.0/DataItemType/<TYPE>`, so `Axes/X/POSITION` and `Axes/W/POSITION` share one;
  the component path, instance and subType stay in the name and `sub_type` (#457). A custom
  MTConnect type is a local extension and gets no id.

- **`metric_catalog.category` is MTConnect's observation category for every standard.** It is
  CHECK-constrained to `SAMPLE`, `EVENT` or `CONDITION` (or null). MTConnect rows carry their own;
  `utils/opcua.js` translates an OPC UA point (a number is a `SAMPLE`, anything else an `EVENT`,
  and nothing maps to `CONDITION`, because OPC UA models faults as alarms, which are not ingested);
  `utils/iso22400.js` files every KPI as a `SAMPLE`; `utils/vda5050.js` follows OPC UA's rule for a
  field's datatype; ASHRAE 223P leaves it null, because a 223P concept is a class of thing, not an
  observation.
- **The Add Metric form offers three Sparkplug datatypes: Double, Boolean and String.** An OPC UA
  integer type (`Int16` to `UInt64`, `Byte`) therefore becomes `Double`, and an unknown or
  specification-defined type becomes `String`, the lossless choice (`sparkplugDatatypeFor()` in
  `utils/opcua.js`). The vocabulary row keeps the type the NodeSet declares. A VDA 5050 field is
  the same: its row says `Int64` for a JSON integer, and the form offers a Double.

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
| Machinery | **OPC 40001-1** v1.04.2, 2026-11-02 | `http://opcfoundation.org/UA/Machinery/` |
| Process Values | **OPC 40001-2** *OPC UA for Machinery, Part 2: Process Values* v1.00.0, 2023-05-01 | `http://opcfoundation.org/UA/Machinery/ProcessValues/` |
| Robotics | **OPC 40010-1** v1.02, 2025-09-08 | `http://opcfoundation.org/UA/Robotics/` |
| Machine Tools | **OPC 40501-1** v1.02.0, 2024-11-01 | `http://opcfoundation.org/UA/MachineTool/` |
| Additive Manufacturing | **OPC 40540** v1.0.0, 2025-02-01 — **not 40450** | `http://opcfoundation.org/UA/AdditiveManufacturing/` |
| Energy | **OPC 40001-4** *Machinery Part 4: Energy Management* v1.00, 2025-11-01 | `http://opcfoundation.org/UA/Machinery/Energy/` |
| IA (read, not seeded) | `http://opcfoundation.org/UA/IA/` v1.01.4, 2025-05-23 — two definitions the Machine Tools and Energy NodeSets take from it | `http://opcfoundation.org/UA/IA/` |
| Digital Nameplate | **IDTA 02006-3-0-3**, the bug-fix release of 3.0 in `admin-shell-io/submodel-templates` at commit `5285185b` (2026-10-29) | `https://admin-shell.io/idta/nameplate/3/0/Nameplate` |
| Asset Interfaces Description | **IDTA 02017-1-0-1**, the bug-fix release of 1.0 at the same commit | `https://admin-shell.io/idta/AssetInterfacesDescription/1/0/Submodel` |
| PackML | **OPC 30050** *OPC UA for PackML* v1.01, 2020-10-08 — **the ISA document is not needed** | `http://opcfoundation.org/UA/PackML/` |
| ASHRAE 223P | ontology `v1.0.0-2026`, **Apache-2.0**; the *standard* is still in public review | `http://data.ashrae.org/standard223#` |
| VDA 5050 | **VDA 5050 3.0.0**, the `state` message's JSON Schema (tag `3.0.0`, 2026-03-18), **MIT** | `https://aber.local/semantics/vda5050/v3.0/State/` (minted here: the VDA issues none) |
| ISO 22400 | **OPC 40501-1** v1.02.0 Annex C (informative), read at `reference.opcfoundation.org/specs/OPC-40501-1/annex-c`, for the four OEE KPIs; ISO 22400-2 itself was not read | `https://aber.local/semantics/iso22400/` |
| QUDT | *QUDT Quantity Kind Vocabulary* and *Units Vocabulary* **3.5.2** (tag `v3.5.2`, 2026-09-22), **CC BY 4.0**; 1,126 kinds and 83 units seeded | `http://qudt.org/vocab/quantitykind/` and `http://qudt.org/vocab/unit/` |

The generator pins the NodeSet paths. Upstream capitalises `NodeSet2` and `Nodeset2`
inconsistently, and the Additive path 404s if you guess it:

```
Machinery/Opc.Ua.Machinery.NodeSet2.xml
Machinery/ProcessValues/Opc.Ua.Machinery.ProcessValues.NodeSet2.xml
Robotics/Opc.Ua.Robotics.NodeSet2.xml
MachineTool/Opc.Ua.MachineTool.NodeSet2.xml
AdditiveManufacturing/Opc.Ua.AdditiveManufacturing.Nodeset2.xml
Machinery/Energy/Opc.Ua.Machinery.Energy.NodeSet2.xml
PackML/Opc.Ua.PackML.NodeSet2.xml
IA/Opc.Ua.IA.NodeSet2.xml
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

**An OPC UA semantic id is the ExpandedNodeId the specification publishes (#458, decided
2026-10-08).** Every `opcua_vocabulary` row carries the NodeId its NodeSet declares for the data
point, written with the namespace URI rather than a server's namespace index:
`nsu=http://opcfoundation.org/UA/PackML/;i=219` for PackML `MachSpeed`. It is both `node_id` and
`semantic_id`, and `semantic_id_type` is `ExpandedNodeId`. OPC UA now follows the rule the
MTConnect ids were written to: no fabricated IRI. Until 1.2.0 the ids were the namespace URI plus
the browse name, `http://opcfoundation.org/UA/PackML/MachSpeed`, an IRI the OPC Foundation never
issued and nothing resolves. MTConnect issues no identifiers at all, so its ids stay minted under
`https://aber.local/semantics/mtconnect/v2.0/`; an IRI under mtconnect.org would claim one
MTConnect never issued.

- **Why the ExpandedNodeId.** It is the one identifier OPC UA itself issues for a concept, and an
  OPC UA client finds the same node by it. The IDTA and OPC Foundation *OPC UA for Asset
  Administration Shell* mapping writes ExpandedNodeId strings as `GlobalReference` values, which
  is the key the exporter already emits for every semantic id.
- **Why not keep the derived IRI and say so.** That was the 1.0 position (#662). A consumer of an
  AAS shell cannot tell a derived IRI from an issued one, and the reason the derived form was
  chosen, that the NodeSets were not read, stopped holding when the generator began reading them.
- **What moved.** `0171` repointed every catalog metric and schema that carried a former id
  exactly, and removed OPC 40001 Machinery `OperationalTime`, which no Machinery NodeSet declares.
  The AAS Digital Nameplate join, i3X's metric-type namespaces and the dashboard read the new form.

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

**A copy is kept in this repository**, at
[`scripts/vocabularies/223p-v1.0.0-2026.ttl`](../scripts/vocabularies/223p-v1.0.0-2026.ttl), and the
generator reads that copy, pinned by its SHA-256. On 2026-10-16 upstream rewrote its history and
regenerated the file: the release above is gone from it, and the new file reports a git revision as
its version and declares no licence. Without a declared licence it can't be used here. The folder's
[README](../scripts/vocabularies/README.md) gives the steps for moving to a newer release.

**VDA 5050's `state` schema is kept the same way,** at
[`scripts/vocabularies/vda5050-3.0.0-state.schema`](../scripts/vocabularies/vda5050-3.0.0-state.schema),
with the VDA's MIT licence beside it, pinned by SHA-256. It is `json_schemas/state.schema` at tag `3.0.0` of
`VDA5050/VDA5050`, byte for byte. The VDA's README says its published PDF prevails where the two
differ, so the vocabulary reads the machine-readable half and claims nothing about conformance.

**QUDT's two vocabulary files are kept the same way,** at
[`scripts/vocabularies/qudt-3.5.2-quantity-kinds.ttl`](../scripts/vocabularies/qudt-3.5.2-quantity-kinds.ttl) and
[`qudt-3.5.2-units.ttl`](../scripts/vocabularies/qudt-3.5.2-units.ttl), with QUDT's licence file beside
them, pinned by SHA-256. They are `VOCAB_QUDT-QUANTITY-KINDS-ALL.ttl` and `VOCAB_QUDT-UNITS-ALL.ttl`
at tag `v3.5.2` of `qudt/qudt-public-repo`, byte for byte. Both declare CC BY 4.0 in their graph
metadata (`dcterms:rights`: "Attribution should be made to QUDT.org").

**IDTA's submodel templates are kept the same way,** at
[`scripts/vocabularies/idta-02006-3-0-3-digital-nameplate.json`](../scripts/vocabularies/idta-02006-3-0-3-digital-nameplate.json) and
[`idta-02017-1-0-1-asset-interfaces-description.json`](../scripts/vocabularies/idta-02017-1-0-1-asset-interfaces-description.json),
with the repository's CC BY 4.0 licence beside them, pinned by SHA-256. They are the JSON IDTA publishes
beside each AASX in `admin-shell-io/submodel-templates`, at commit `5285185b`. **The Nameplate's copy is not
byte for byte.** Its file carries 27 ConceptDescriptions whose definitions IEC CDD and ECLASS issued, under
terms of their own, and the copy leaves those out. The folder's
[README](../scripts/vocabularies/README.md) gives both SHA-256s and the steps for another template.

**MTConnect's definitions are read from a kept copy of the 2.7 XSD** (#779), at
[`scripts/vocabularies/MTConnectDevices_2.7.xsd`](../scripts/vocabularies/MTConnectDevices_2.7.xsd),
pinned by SHA-256. `DataItemEnumEnum` documents 248 of the 249 data item types. The model's markup
(`{{block(…)}}`, `{{term(…)}}`, `{{property(…)}}`, `{{cite(…)}}`, `{{termplural(…)}}`) is rendered to plain
words, and a type with no documentation, ELEVATION, which 2.8 added, keeps none. The 2.8 JSON Schema,
which the generator still reads for the names, carries no type documentation. The newest published XSD
is 2.7. The model's own repository, `mtconnect/mtconnect_sysml_model`, is not a source: it has no
licence file, and its terms allow copying only in the form received.

### ISO 22400 and its source

ISO 22400-2 is a purchased standard. A purchased ISO standard is licensed to its reader, and Aber is
distributed publicly, so rows taken from its text would raise a redistribution question this project
should not have to answer. Each ISO 22400 row needs a source anyone can read. For four of them there
is one: **OPC 40501-1 v1.02.0, Annex C**, *KPI Calculation (Informative)*, which is free to read at
`reference.opcfoundation.org` and says "The KPI definitions used are taken from the ISO 22400-2
specification". Migration `0305` cites it for `AVAILABILITY`, `EFFECTIVENESS`, `QUALITY` and `OEE`.

- **What the annex gives.** C.1 defines the abbreviations: APT (Actual Production Time), PBT (Planned
  Busy Time), PQ (Produced Quantity), GQ (Good Quantity), PRI (Planned Run Time Per Item) and OEE.
  C.2.4, *Calculation of the OEE*, says "The OEE (Overall Equipment Effectiveness) is the product of
  Availability, Effectiveness and Quality Rate" and gives `Availability = APT / PBT`,
  `Effectiveness = PRI x PQ / APT` and `Quality rate = GQ / PQ`. C.2.1 to C.2.3 map PQ, GQ, APT, AUST
  and ADET to OPC UA variables. The annex gives formulas and no prose definition of a KPI.
- **`iso22400_vocabulary.source`** holds the citation, for those four rows only: the annex, its clause
  and the formula in the annex's words. The ISO 22400 tab shows it on its own line of the KPI's
  tooltip, and an AAS export carries it as the ConceptDescription's `sourceOfDefinition`.
- **The descriptions follow the annex.** The released seed quoted ISO 22400-2 names the annex does
  not use ("Quality ratio", "OEE index"), which nobody could check. The annex says "Quality rate" and
  "OEE", and each description now says what the annex's abbreviations say and no name it does not give.
  The `formula` column is unchanged: it is the annex's formula with the KPI's symbol in front.
- **`concept_sources` is a view of its own.** `(semantic_id, source)`, one row per id, with two arms:
  ISO 22400 (a row with a source) and QUDT (every seeded kind: "QUDT 3.5.2, QUDT.org, CC BY 4.0"). It
  is not a column of `concept_definitions`, because that view's four columns are stated inline by
  `0169`, `0301`, `0302` and `0304`, and db-init replays each on every boot: a view that gained a
  column would be redeclared narrower by the next boot of the earlier file and fail with "cannot drop
  columns from view". A vocabulary added later adds an arm.
- **The other four rows cite nothing, and are deprecated.** No free source publishes the formulas of
  `SCRAP_RATIO`, `MTBF` or `MTTR`, and `UTILIZATION` is not an ISO 22400 KPI: its own description said
  so, and it still sat in a table whose name says it is. `iso22400_vocabulary.deprecated_reason` holds
  why (NULL means live), and the ISO 22400 tab marks the four in words and says why. A site that owns
  ISO 22400-2 can import it on the Vocabulary page, with its licence recorded, so Aber does not need to
  ship unchecked copies. The deprecation is announced in 1.9.0 and the rows are removed no sooner than
  1.10.0 (`docs/releases.md`, *Deprecation*). Through that window the four rows, their metric groups
  (`Quality`, `Utilization` and `Maintenance`) and their example metrics stay. An install keeps any
  metric that carries one of these ids, since an id is only a value, and such a metric's
  ConceptDescription takes the catalog's description instead. OPC 40001-1 v1.04.2 Annex C, read at
  `reference.opcfoundation.org`, maps `MachineryItemState` and `MachineryOperationMode` to ISO 22400-2
  time elements, TTR among them, and says "This annex does not define any KPI values." The ~26 other KPIs of ISO 22400-2 are not added, because no free source
  publishes them.
- **The annex is cited, not vendored.** It is free to read, and three formulas and a sentence are
  quoted with the citation; nothing is redistributed whole.

### Licences

Every vocabulary comes from an open, machine-readable source whose licence permits redistribution
in a derived work, and every licence was read rather than assumed:

| Source | Licence | Asserted by |
|---|---|---|
| The OPC UA companion specification NodeSets the generator reads | OPC Foundation MIT License 1.00, which every NodeSet in `OPCFoundation/UA-Nodeset` carries | file header |
| IDTA 02006-3-0-3 Digital Nameplate and IDTA 02017-1-0-1 Asset Interfaces Description | CC BY 4.0, attribution to the Industrial Digital Twin Association (IDTA). The IEC CDD and ECLASS definitions the Nameplate's file carries are not taken | `LICENSE.txt` of `admin-shell-io/submodel-templates` at commit `5285185b`, which GitHub also detects as CC BY 4.0 |
| ASHRAE 223P ontology | Apache-2.0 | `dcterms:license` in the ontology |
| VDA 5050 `state.schema` | MIT, copyright 2024 Verband der Automobilindustrie | the repository's `LICENSE.txt` at the tag |
| MTConnect `MTConnectDevices_2.7.xsd` (the definitions) | BSD-style licence from AMT, in the file; the repository is Apache-2.0 | header of the file, and the repository's licence |
| OPC 40501-1 v1.02.0 Annex C (cited, not vendored) | free to read on the OPC Foundation's reference site; three formulas and a sentence are quoted, each with the citation | the reference site, which carries the specification |
| QUDT 3.5.2 quantity kinds and units | CC BY 4.0, attribution to QUDT.org. The units file's metadata also carries a UCUM notice, which covers the UCUM codes, and none is taken | `dcterms:rights` in each file's graph metadata, and the repository's `LICENSE.md` |

As with MTConnect's Apache-2.0, a licence covers the *vocabulary*, not a conformance claim.

## OPC UA companion specifications

`opcua_vocabulary` holds seven companion specifications and 124 data points, every row read from its
NodeSet:

| Companion specification | Data points | Seeded by |
| :--- | ---: | :--- |
| OPC 30050 PackML | 19 | `0002` (16), `0300` (3) |
| OPC 40001 Machinery | 19 | `0002` (9), `0300` (10) |
| OPC 40001-2 Machinery Process Values | 8 | `0300` (8) |
| OPC 40001-4 Machinery Energy | 8 | `0002` (6), `0300` (2) |
| OPC 40010 Robotics | 26 | `0002` (15), `0300` (11) |
| OPC 40501 Machine Tools | 33 | `0002` (23), `0300` (10) |
| OPC 40540 Additive Manufacturing | 11 | `0002` (6), `0300` (5) |

`scripts/generate-opcua-vocabulary.mjs` writes them into marked blocks in the migrations that seed
them, with their `metric_groups` rows, and `scripts/check-opcua-seed-sync.mjs` verifies them in CI.
The generator also writes the table's `COMMENT`, naming every specification seeded up to that
block, and the check recomputes it, so a specification added by hand cannot leave the comment
behind. The check also refuses an `opcua_vocabulary` row written outside a generated block, in any
migration.

- **The seed is curated, not dumped.** The NodeSets carry almost no descriptions — MachineTool
  declares 356 variables of which 18 have one, Machinery/Energy has 87 and none — so a bulk
  extraction would have produced hundreds of rows with a NULL description, and `VocabularyPanel`
  searches the tooltip as well as the name. The generator instead *verifies* a curated entry list
  against the NodeSet and reads the datatype and the NodeId from it, failing if an ObjectType, a
  member or the pinned specification version is not what it expects. Each entry names an
  ObjectType and the browse path below it, one declared component or property per step, such as
  Robotics `AxisType` → `ParameterSet` → `ActualPosition`. A step that names two nodes stops the
  build, because the NodeId becomes the row's identifier.
- **A description follows the NodeSet's where it has one.** 30 of the 49 rows `0300` added take the
  NodeSet's own `Description`, shortened. The other 19 are written from the specification's
  reference page for the type, which the NodeSet links, or from the enumeration it defines.
- **The NodeId is translated, not copied.** A NodeSet writes `ns=3;i=16662`, where `3` indexes
  that file's own `NamespaceUris` table. The generator writes `nsu=<that URI>;i=16662`, which means
  the same node outside the file, and refuses a node outside the row's own specification.
- **The dashboard's group for each point is generated too.** `node_id` used to be a browse path,
  and the Add Metric form took a point's group from its first segment. The generator now writes
  each entry's curated group to `frontend/src/utils/opcuaGroups.generated.js`, and the check holds
  it to the rows and to the `metric_groups` the seed registers under OPC UA.
- **The rows live in blocks, one for each migration that grew the vocabulary.** `0002` is released
  and is not regenerated, so `0300` seeds the rows added since in a block of its own. Each entry
  in the generator says which block seeds it (`since`), and each block is written from its own
  entries. A block is written only while its migration has a note in `unreleased/migrations/`. After
  the release the generator only verifies it, and stops if it would now read differently. The next
  expansion adds a third block the same way: `scripts/lib/opcua-seed-blocks.mjs` has the rules.
- **A group can be reworded.** `ProcessValue` was OPC 40540's group for in-process readings. OPC
  40001-2's rows joined it in `0300`, so its description now covers both. `0002` still registers the
  first text, and `0300` replaces it with an `UPDATE` guarded on that text, so a description an
  Administrator edited is left alone. Both specifications list the group with one definition, and
  the generator refuses two that differ.
- **A type can come from another NodeSet.** A Machine Tools stacklight's mode is an enumeration of
  IA, and Machinery Energy hangs its non-electrical totals from IA's `HasStatisticComponent`, a
  subtype of `HasComponent`. The generator reads IA's NodeSet too, pinned as the others are. It
  seeds nothing from it.
- **An enumeration is a `String`, and its members are the permitted values.** A device publishes an
  enumeration as the member's name. OPC 40540 `Function` says so in its description and lists the
  four names: Undefined, Main, Ancillary and Consumable. The entry's `values` are held to the
  NodeSet's definition, and the description has to name each. Enter them in the **Permitted
  Values** field of Add Metric, as for PackML's states (below). The vocabulary table has no column
  for them, so the form does not fill the field.
- **Left out on purpose:**
  - PackML's three count arrays, which are arrays of a structure that Sparkplug B cannot carry.
  - Machine Tools `FeedOverride` on its monitoring type, which would clash with the seeded channel
    `FeedOverride`, because the table is keyed on the specification and the name.
  - Alarm and condition internals, state-machine scaffolding and placeholder members such as
    `<Tool>`.
  - OPC 40540's `RunInfoDataType`, a structure that no variable in the NodeSet uses.
- **A printer is a machine tool, and its readings are process values.** OPC 40540's
  `AdditiveManufacturingType` subtypes OPC 40501's `MachineToolType`, so the Machine Tools and
  Machinery sections apply to a printer. Its `ProcessValueAMType` subtypes OPC 40001-2's
  `ProcessValueType`: a chamber temperature or an oxygen level is a process value that the vendor
  names, and the specification gives only its shape. MTConnect names what a printer measures.
- **`companion_spec` spellings follow the existing `OPC 40001 Machinery` shape** and are permanent:
  `enforce_metric_group_spelling()` fixes the first spelling of the matching `metric_groups` rows.
- **`standard` stays `'OPC UA'`**, so no new `STANDARDS` entry was needed in the frontend.
- **i3X needs no change.** `metric_type_namespace()` already puts an id under
  `http://opcfoundation.org/UA/` in that id's own namespace.

## IDTA submodel templates

A submodel template says which elements a submodel holds: their names, types and semantic ids, and how many
of each. A submodel that names the template's id claims to hold them. Built as migration `0320`:
`idta_template_elements` with **396 elements** of two templates, generated by
`scripts/generate-idta-template.mjs` into a marked block of that migration and guarded by
`scripts/check-idta-seed-sync.mjs`, plus a Vocabulary-page tab and an API route.

| Template | Elements | Top level |
| :--- | ---: | ---: |
| Digital Nameplate 3.0.3 (IDTA 02006) | 36 | 20 |
| Asset Interfaces Description 1.0.1 (IDTA 02017) | 360 | 3 |

- **A row is an element, keyed by the template and its path.** The path is the AAS API's idShortPath,
  `Markings[0].MarkingName`, so an idShort that repeats in two collections is two rows. `parent_path` and
  `ordinal` give the tree: read by `ordinal`, each element follows its parent.
- **Another template is a file plus one line.** The file goes in `scripts/vocabularies/`, and the line in
  `TEMPLATES` (`scripts/lib/idta-template.mjs`). The generator stops at a model type, a qualifier, a
  cardinality or an id it does not know, rather than dropping it. A block is written only while its migration is
  unreleased, as the OPC UA blocks are, so the next template goes in a block of the migration that adds it.
- **A table of its own, beside `idta_submodel_templates`.** The older table is released, and its key,
  `(template_id, id_short)`, cannot hold a nested element. Its 20 rows stay exactly as they are, with their
  readers: the Nameplate dialog, the semantic id picker, `concept_definitions` and the AAS export. Drift check
  567 holds them to the Nameplate's top-level elements here.
- **The two tables differ in two places.** The released rows mark `YearOfConstruction` mandatory and
  `OrderCodeOfManufacturer` optional, as version 2.0 of the template did. Version 3.0 swapped the two.
- **No IEC CDD or ECLASS text.** A template cites those dictionaries for most of its concepts, and its file
  carries their definitions. The kept copy leaves them out, and the generator refuses a file that has one. The
  identifiers stay, because an identifier is only a value. So 14 of the Nameplate's 36 elements have a
  definition: IDTA's own notes, and the definition it wrote for `UniqueFacilityIdentifier`.
- **A filler is not a definition.** Asset Interfaces Description's file says `EMPTY` for every concept, and
  `Current counter value` for a sample property. Neither is taken. What is taken is a constraint, such as
  "Only applicable for MQTT binding", on 57 of its 360 elements.
- **`definition` is not a concept's definition.** It is what a template says of an element in that template,
  so `concept_definitions` has no arm for it and no export reads it.
- **`AddressInformation` has nothing inside it.** It is mandatory in the Nameplate, and the template takes its
  elements from IDTA's drop-in of that name, which is in Contact Information (IDTA 02002). That template is
  not seeded. The specification makes four of the drop-in's elements mandatory here (`Street`, `Zipcode`,
  `CityTown` and `NationalCode`), in its text only, so no file says so.
- **Its ids are never minted here.** IDTA, IEC CDD, ECLASS and W3C issue them, and each is taken as the file
  writes it. 6 elements have none, and 12 of Asset Interfaces Description's elements have no cardinality.
- **The Templates tab reads it and nothing else does.** It lists every template, each element under its
  parent, and starts no metric: a template is not a vocabulary a metric is named from, so it is not a
  `STANDARDS` entry and registers no metric group. It credits IDTA under CC BY 4.0, as the licence asks.
- **Listing a template claims no conformance to it.**

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
  published release is the defensible choice. The rows were typed from it by hand. The generated elements
  of the same template, nested ones included, are in `idta_template_elements` (above).
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
the shell reports, and the table fills the gaps. A metric carrying the Machinery id as a further
semantic id answers too, after any metric that carries it as its own.

**The editor is a modal opened from a device's drawer**, **Digital Nameplate…**, between
**Configuration Parameters** and **Export…** (one dialog for AAS JSON, an AASX package and a
bundle), with **Attached Links** below — placed directly above the export because it is the only
entry there that changes what it contains. It is deliberately *not* on the Schemas page: that page is
entirely type-level (what a metric may be named, what a standard defines), and a nameplate is a
fact about one physical asset.

The form shows fields the device publishes for itself as **read-only, with the device's value**.
That is not a limitation but the point: the exporter prefers a published value, so an editable
field would accept a serial number, save it, and never show it in the shell with nothing on screen
explaining why.

**The Vocabulary page holds the standard reference** (`/vocabulary`), the submodel templates among it, split
out of Schemas.
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
telemetry and stored nowhere, and its wiring into the Devices tab. Add Metric and Edit write the
column; both schema builders copy it into each property's `enum`, in the property's JSON type
(`utils/schemaProperty.js`), which is what `ingestion/conformance.py` judges a reading against.
`test-harness/fixtures/schema-builder-output.json` holds the builders' output to ingestion's
reading of it.

**`permitted_values` is not frozen**, which is the opposite of the obvious decision. The argument
for freezing — a device is configured against its value set the way it is configured against its
name — does not survive asking what the column is. `name` and `datatype` are a wire contract: a
device is physically configured against them and changing one re-points historical telemetry.
`permitted_values` is a transcribed assertion about a standard that nothing is configured against.
No device reads it, and no historical row moves when it changes. Ingestion never reads the column
itself: a published schema carries a copy of the set as it was at publish time, as `enum`. Editing
the catalogue row changes no published schema; the next version saved in the dashboard takes the
new set, or loses its `enum` when the set was cleared. Freezing it would mean a mistyped value could
only be corrected by deprecating the metric and re-provisioning every device that publishes it, to
fix a string that never left the database. That is exactly the trade archived migration 0029 already
refused for `semantic_id`, in the same table, for the same reason. Standards also *add* values
between editions, so a frozen set would go stale by the standard's action rather than anyone's
mistake. `test_metric_catalog_seed.py` (db lane) fails if a later edit freezes it, or frees `name` or
`datatype`.

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
- **Only the `s223:` namespace is seeded here.** The ontology `owl:imports` QUDT
  (`http://qudt.org/3.2.1/shacl/qudt-all`) for quantity kinds and units. Following it would pull in
  a second vocabulary several times the size, under its own licence (CC BY 4.0), so QUDT is a
  vocabulary of its own, read from its own release ([below](#qudt-quantity-kinds-and-units)).
- **Browsable without a BMS adapter.** Per-point tagging over BACnet is the long pole, and the
  vocabulary does not wait for it.

**223P is a reference here, not a source of metric semantic ids (#461).** A 223P class names
equipment or a substance, not a reading. In 223P a reading is a `QuantifiableObservableProperty`
with a QUDT quantity kind (`qudt:hasQuantityKind`), observed by a sensor. So
`TemperatureSensor` as the semantic id of a Property whose value is 21.4 tells an AAS consumer the
Property is a sensor. The dashboard therefore offers no 223P class as an id: `ashrae223Prefill()`
fills none, and neither the suggestion nor *Search vocabularies* lists one. Use on the Vocabulary
page starts a metric in the `BMS` group, named after the class, and the operator supplies the
datatype, the units and the id. A class shows as in use when a 223P metric is named after it.
`check-docs-drift.mjs` check 47 holds the prefill and the example set to this.

**The five example readings carry the published QUDT quantity kind of what each reports**, as
`http://qudt.org/vocab/quantitykind/<Kind>` with `semantic_id_type` `IRI`. Each IRI was
dereferenced on 2026-10-08 and is defined by QUDT 3.5.2's quantity-kind vocabulary, none
deprecated. Each kind is the one the pinned 223P ontology's sensor class admits for that reading,
and QUDT lists the metric's unit among the kind's units (`unit:PERCENT_RH` for the humidity's
`PERCENT`):

| Metric | Unit | Quantity kind | Why this kind |
| :--- | :--- | :--- | :--- |
| `BMS/ZONE_TEMPERATURE` | `CELSIUS` | `Temperature` | the only kind 223P's `TemperatureSensor` admits |
| `BMS/ZONE_HUMIDITY` | `PERCENT` | `RelativeHumidity` | `HumiditySensor` admits it or `AbsoluteHumidity`, and the reading is relative |
| `BMS/CO2_CONCENTRATION` | `PARTS/MILLION` | `MoleFraction` | see below |
| `BMS/STATIC_PRESSURE` | `PASCAL` | `Pressure` | `PressureSensor` admits `Pressure` or `GaugePressure` only, so QUDT's narrower `StaticPressure` would fail its shape; `GaugePressure` claims a reference to atmosphere the metric does not state |
| `BMS/SUPPLY_AIR_FLOW` | `LITER/SECOND` | `VolumeFlowRate` | the kind `FlowSensor` names as typical |

**CO2 is a `MoleFraction`.** QUDT lists `unit:PPM` under `DimensionlessRatio`, `MoleFraction` and
`AmountOfSubstanceFraction`; `VolumeFraction` does not list it. 223P's `ConcentrationSensor`
names `MoleFraction` among the kinds a concentration may take, and the Guideline 36 example model
on `models.open223.info` gives its *Zone CO2 Concentration* `MoleFraction` in `unit:PPM`. The
pinned ontology's Guideline 36 `Zone` shape asks for `DimensionlessRatio` with `ofConstituent
Constituent-CO2`. `MoleFraction` is a narrower kind of `DimensionlessRatio` (`skos:broader`), so a
consumer following QUDT reaches the shape's kind; `DimensionlessRatio` alone would give CO2 the id
of every percentage, since the constituent has nowhere to go here.

**The five kinds are rows of `qudt_quantity_kinds`.** They are typed in `example-metrics.sql`, the one
place that file does not take an id from a vocabulary table, so its inner join does not check them.
Check 47 is the join: each kind must be a seeded row, and the five must be the pairs migration `0172`
repoints an install to. That install holds the old 223P class ids, seeded by `0002` up to 1.0.1 and by
the example set since, and `0172` moves a row only while its id is still the seed's. An AAS export
defines each of these ids by QUDT's own description of the kind, never by a reading's description or
as 223P's, and i3X files their types in QUDT's namespace
([below](#qudt-quantity-kinds-and-units)). The CO2 reading's unit, `PARTS/MILLION`, is not an
MTConnect name, so its export carries no `unitId`.

**The rest of the model waits for a BMS adapter:** a second field saying what a point is attached to
(its 223P class). Until then the class lives only in a metric's name.

## QUDT (quantity kinds and units)

Built as migration `0304`: `qudt_quantity_kinds` with **1,126 quantity kinds** and `qudt_units` with
**83 units**, generated by `scripts/generate-qudt-vocabulary.mjs` into two marked blocks in `0304` and
guarded by `scripts/check-qudt-seed-sync.mjs` and `scripts/check-qudt-crosswalk.mjs`, plus a
Vocabulary-page tab, a place in the semantic id picker, an API route, an i3X namespace and `unitId` in
the AAS export. A quantity kind names what a reading measures (`Temperature`, `VolumeFlowRate`), not
the reading.

- **Source, licence and credit.** QUDT release 3.5.2 (tag `v3.5.2`, 2026-09-22), kept whole in
  `scripts/vocabularies/` and pinned by SHA-256, as 223P's ontology is. QUDT declares CC BY 4.0 in
  both files and asks that attribution is made to QUDT.org. The Vocabulary tab says "Quantity kinds
  from QUDT 3.5.2, by QUDT.org, under CC BY 4.0", with the licence linked. `NOTICE.md` and the
  Licences table say it too. The units file also carries a UCUM notice in its metadata. It covers
  the UCUM codes, and none is taken.
- **The ids are QUDT's own,** `http://qudt.org/vocab/quantitykind/<Name>` and
  `http://qudt.org/vocab/unit/<Name>`, so nothing is minted and a CHECK on each table admits no other
  prefix. The IRI is the key, because two kinds can share an English label.
- **Every kind that is not deprecated is a row, and only the units the crosswalk reaches.** The kinds
  file holds 1,225 `quantitykind:` subjects. One has a wikidata match and no type or label, so 1,224
  are kinds, and 98 of them are deprecated. Its units file holds 2,932 units, 85 deprecated, and 1,577
  carry a UN/ECE Recommendation 20 code (one of them two). Some 4,000 rows would bury the picker,
  which is why the OPC UA seed is curated too. The picker searches, so every kind can go in; the units
  table needs only what `unitId` uses.
- **A kind's description is QUDT's, as plain text.** It is `qudt:plainTextDescription`, else
  `dcterms:description`, in English, with the HTML tags removed, the LaTeX written out
  (`$\textit{Absolute Humidity}$` is `Absolute Humidity`) and the whitespace collapsed. 122 of QUDT's
  plain-text descriptions are German, and those kinds take their English description. 171 kinds have
  none, and their description is NULL. QUDT writes some of its LaTeX with a backslash that Turtle
  reads as an escape, so a `\textit` can arrive as a backslash and a tab: the reader puts it back. A
  command it does not know stops the generator, so a release that adds one is read before it is
  seeded.
- **A kind is a semantic id where no other standard names the reading.** A Custom metric or an
  ASHRAE 223P metric can have one as its own id. Any metric can have one as a further id (`0299`).
  Add Metric's picker offers a kind as the primary id only under those two, and Edit's further-id
  editor offers it for every metric. A metric another standard names, such as an MTConnect
  `TEMPERATURE`, keeps its own id, or an operator would replace a standard's id with a broader one
  and the provenance the Standard column records would stand for nothing. A kind typed in by hand
  under another standard gets the note that it replaces that standard's id.
- **QUDT is not a `STANDARDS` entry,** and no metric group is registered for it. A metric is never
  filed under it. Mirror check 119 exempts it as it exempts IDTA, and check 124 holds its label to
  the view.
- **`concept_definitions` has a QUDT arm** between ASHRAE 223P's and OPC UA's, because QUDT issues
  its own IRIs, as 223P does. Its columns are the view's four, so nothing a released file states
  changes.
- **i3X files a kind's type in QUDT's namespace,** `http://qudt.org/vocab/quantitykind?projection=i3X`,
  as a projection, as 223P's is. A unit is not a kind and stays local.
- **The crosswalk to MTConnect's units** is
  [`scripts/vocabularies/mtconnect-units-to-qudt.json`](../scripts/vocabularies/mtconnect-units-to-qudt.json):
  each of the 54 UnitEnum names and 46 further NativeUnitEnum names, read from the seed, maps to one
  QUDT unit IRI or to nothing with a one-line reason. **83 map and 17 map to nothing.** A name maps
  only where QUDT has exactly that unit, in quantity and scale. Where QUDT lists two units as the same
  unit (`qudt:exactMatch`), the one that carries a UCUM or UN/ECE code is used (`NUM` for `COUNT`, `IN`
  for `INCH`), and where both carry one the name maps to nothing (`POUND`: `LB` and `LB_M`;
  `POUND/INCH^2`: `PSI` and `LB_F-PER-IN2`). The other 15 are a vector or direction with no unit
  (`DEGREE_3D`, `MILLIMETER_3D`, `FOOT_3D`, `INCH_3D`, `UNIT_VECTOR_3D`), the catch-all `OTHER`, four
  units QUDT does not have (`CUBIC_MILLIMETER/SECOND`, `CUBIC_MILLIMETER/SECOND^2`,
  `MILLIGRAM/CUBIC_MILLIMETER`, `MILLIMETER/REVOLUTION`), `GALLON/MINUTE`, which does not say which
  gallon, `GRAVITATIONAL_ACCELERATION`, whose g is 9.90665 m/s2 in MTConnect and 9.80665 in QUDT,
  `GRAVITATIONAL_FORCE`, and the two counts per million and per trillion, which QUDT's parts per
  million and per trillion do not match in quantity. The check fails when a name is missing from the
  crosswalk, when it names one MTConnect does not, and when an IRI is not in the units file or is
  deprecated there.
- **`unitId` in the export.** A metric's `units` is an MTConnect name, written as free text into the
  IEC 61360 `unit` as before. Where the crosswalk maps the name, the ConceptDescription also carries
  `unitId`, an ExternalReference with one GlobalReference key, the QUDT unit's IRI. The exporter reads
  a map generated from the crosswalk, `supabase/functions/_shared/aas/qudtUnits.ts`, and the seed-sync
  check holds the map to the crosswalk, so the export makes no extra read. Metrics sharing a concept
  and disagreeing on the unit export neither `unit` nor `unitId`.

## VDA 5050 (AGVs)

Built as migration `0302`: `vda5050_vocabulary` with **24 fields**, generated by
`scripts/generate-vda5050-vocabulary.mjs` into a marked block of that migration and guarded by
`scripts/check-vda5050-seed-sync.mjs`, plus `STANDARDS.VDA5050`, `utils/vda5050.js`, a Vocabulary-page
tab, a Field picker in Add Metric, an API route and an i3X namespace. AGVs were the one pilot asset
class with no vocabulary. Like 223P it has a table of its own: it is not an OPC UA companion
specification, so filing it in `opcua_vocabulary` would misstate where it came from.

- **The source is the schema the VDA publishes, not its PDF.** `json_schemas/state.schema` at tag
  `3.0.0`, kept in `scripts/vocabularies/` (see above). The generator walks it from the root,
  resolves each `$ref`, follows object properties and does not enter an array.
- **A row is a scalar field that is a reading, keyed by its path in the message** (`name`, with a dot
  between the levels): `driving`, `paused`, `newBaseRequest`, `operatingMode`, `lastNodeId`,
  `distanceSinceLastNode`, `velocity.vx`, `.vy`, `.omega`, `powerSupply.stateOfCharge`,
  `.batteryVoltage`, `.batteryCurrent`, `.batteryHealth`, `.charging`, `.range`,
  `safetyState.activeEmergencyStop`, `.fieldViolation`, and `mobileRobotPosition.x`, `.y`, `.theta`,
  `.mapId`, `.localized`, `.localizationScore`, `.deviationRange`. Each has the schema's type and
  description. An enum's values become `permitted_values`, as PackML's states do: `operatingMode` has
  seven, `activeEmergencyStop` three.
- **What the walk leaves out is decided by name, with the reason.** Every scalar leaf is kept or
  excluded in `scripts/lib/vda5050-vocabulary.mjs`, and a leaf in neither stops the build, so a
  release that adds a field is read rather than absorbed. The arrays (`loads`, `errors`,
  `actionStates`, `nodeStates`, `edgeStates` and the rest) are lists of structures, and Sparkplug B has
  no composite type, so the generator refuses them as the OPC UA generator refuses STRUCTURE
  datatypes. The header (`headerId`, `timestamp`, `version`, `manufacturer`, `serialNumber`) is left
  out because a device's identity comes from its Sparkplug topic, and the order flow (`orderId`,
  `orderUpdateId`, `lastNodeSequenceId`) because Aber does not run orders. So is
  `plannedPath.trajectory.degree`, a number inside a route's curve.
- **Datatypes:** a JSON number is a Double, an integer an Int64, and a boolean and a string are a
  Boolean and a String. All 24 are numbers, booleans or strings. None is an integer today, so the
  Int64 mapping is declared and never used; the Add Metric form would offer it as a Double.
- **Ids are minted here,** `https://aber.local/semantics/vda5050/v3.0/State/<path>`, because the VDA
  issues none. They follow MTConnect's rule: this deployment's namespace, pinned to the major line,
  then the kind of thing named (the `state` message) and the name. A later message from the same
  schema would take its own segment.
- **The group is `AGV`.** `enforce_metric_group_spelling()` makes the first spelling permanent. `AGV`
  is the word this document and the pilot shopfloor use, and it cannot be confused with OPC 40010's
  robots. A metric is `AGV/<the path with slashes>`, so `velocity.vx` is `AGV/velocity/vx`; a name
  cannot hold a dot. The group's description, the tab's tooltip and the help say that VDA 5050 3.0
  calls the vehicle a mobile robot.
- **Definitions follow the rows.** `concept_definitions` has a VDA 5050 arm, last, since these ids
  are minted under `aber.local` as ISO 22400's and MTConnect's are. Three position fields
  (`mobileRobotPosition.x`, `.y`, `.theta`) carry a unit and no description in the schema. They have
  none here, and an export defines them by the catalog's text, as it does an id no vocabulary holds.
- **The unit is the schema's keyword, and Add Metric does not fill it in.** `unit` holds `m/s`, `rad`
  and the rest as the VDA writes them. A metric's unit is an MTConnect UnitEnum name, so the form
  leaves **Units** to the operator until units for these readings are crosswalked (#942).
- **Position stays telemetry.** `mobileRobotPosition` is a reading on the device, never
  `devices.cell_id`.
- **Nothing speaks VDA 5050.** The vocabulary names the readings. A vehicle must still publish them
  as Sparkplug B metrics, and the edge adapter that would do it is the catalogue of edge connectors'
  business (#307).

## Site vocabularies

A site can bring its own vocabulary: a group's naming standard, a customer's specification, or the
concepts of a standard it holds a copy of, such as ISO 22400-2 or an ECLASS release. Built as
migration `0306`, on the Vocabulary page's **Imported** tab. Nothing here is seeded, so nothing here
is verified against a source Aber ships: the file is the site's.

- **What can be imported.** AAS ConceptDescriptions with the IEC 61360 data specification: an
  identifier, a preferred name, a definition, a unit and a data type. The file is an `.aasx`
  package, an AAS JSON environment or an AAS XML environment, read by one reader in the browser
  (`frontend/src/utils/aasReader.js`, shared with #483's supplier AASX import and #489's template
  upload). Only the V3 metamodel is read. A NodeSet2 file is #809's. **No CSV and no format of
  Aber's own**, because a custom file has no standard, and the easiest route would be the one
  everybody took.
- **The file is hostile.** It is refused over 25 MB. Inside a package it is refused for more than
  5,000 entries, any entry over 50 MB expanded, more than 100 MB in all, an entry that inflates to
  more than 100 times its packed size, and an entry named with an absolute path, a `..` segment, a
  backslash or a drive letter. Every count is made while the bytes are inflated, never from the
  sizes the zip declares. An XML document with a `<!DOCTYPE` is refused before it is parsed, so no
  entity is ever declared. Each refusal names its reason in the dialog.
- **A package is read through its relationships** (IDTA 01005): the origin's `aas-spec` relationship
  names the environment. A package with none is refused, and the reason says which link is missing.
- **Two tables.** `site_vocabularies` has one row for each file: its name, format, SHA-256, the
  version it states, a licence note, whether its definitions are shared, and who imported it and
  when. `site_vocabulary_concepts` has one row for each concept, and a semantic id is held by one
  file only. Every signed-in role reads them. Only `import_site_vocabulary()`,
  `remove_site_vocabulary()` and `set_site_vocabulary_sharing()` write them, each for an
  Administrator behind the second factor, each filing one Audit Trail row.
- **The import says what the file is.** A **published standard** is named by its name, edition and
  publisher (`ISO 22400-2`, `2014`, `ISO`). The **site's own vocabulary** names no standard. The
  preview shows the format, the version the file states, how many concepts will be imported, how
  many were skipped for no IEC 61360 content, and which ids a vocabulary already defines and which
  one. The database checks every row again, and skips an id that a seeded vocabulary, another file
  or the file itself already defines. A file whose SHA-256 is held is refused, naming the file.
- **Provenance stays honest.** A metric started from an imported concept keeps `standard` NULL and
  links to the file (`metric_catalog.site_vocabulary_id`). The Metrics page labels it from the
  file: *ISO 22400-2:2014 (site licence)* for a published standard, the file's name for a site's
  own vocabulary, so nobody takes it for a standard Aber ships. The Standard filter offers each
  published standard a site imported. **`STANDARDS` stays closed**: the dashboard and i3X mirror it,
  and a site's own name in it would claim a standard that does not exist. A typed "this is ISO
  22400" would carry no evidence and still flow into every export; a file arrives with its SHA-256,
  version and importer. The AAS export files a metric started from a published standard whose name
  begins `ISO 22400` under KeyPerformanceIndicators, as it files a metric with `standard = 'ISO
  22400'`.
- **Buying a standard gives definitions, not identifiers.** ISO issues no ids for the 22400 KPIs,
  so a site's ConceptDescriptions for them carry ids the site mints. Aber's seeded ISO 22400 rows
  and a site's licensed import sit side by side under different ids, and the label tells them
  apart.
- **Licensed definitions stay home until an Administrator says otherwise.** An export carries an
  imported concept's id and preferred name. Its definition is the file's text only once the
  Administrator confirms that the licence allows sharing it (**Share definitions**, with a line
  saying the licence is the site's responsibility). Until then the IEC 61360 definition, which is
  mandatory in English, is "*name*, as *ISO 22400-2:2014* defines it.", and it never falls back to
  the catalog's description, which may be a copy of the licensed text. For the same reason a metric
  carrying such an id, as its own id or a further one, exports no description on its own element
  (`withholdsDescription()`). The rule is in
  `buildConceptDescriptions()`, so the AAS API's `/concept-descriptions` routes serve the same
  text. Add Metric leaves the description empty when the definitions are not shared, for the same
  reason.
  `concept_definitions` has an arm for imported concepts, last in precedence, with no standard, and
  it holds only vocabularies whose definitions are shared.
- **Removing a vocabulary** says first how many metrics use it. They keep their ids, because an id
  is only a value, and lose the link. Only the definitions go: an export falls back to the catalog
  description.
- **The seeded standards are never deleted.** db-init would put them back, and no migration deletes
  rows an install already holds. A setting that hides a seeded standard's tab is not built.

---

## Definition of done — applies to every vocabulary

> Kept here as the authoritative list. The same checklist is reachable from
> [`supabase/README.md`](../supabase/README.md#adding-a-vocabulary).

1. Migration is **idempotent** (`ON CONFLICT … DO UPDATE`); db-init replays it every boot.
2. RLS enabled, SELECT policy for `authenticated`, `REVOKE ALL FROM PUBLIC, anon`, no write policy.
3. `metric_groups` rows registered in the migration, carrying `standard` provenance. QUDT and the IDTA
   templates register none, because no metric is named from them.
4. `NOTIFY pgrst, 'reload schema'`.
5. A generated seed is generated by a committed script and guarded by a seed-sync check in CI,
   rather than transcribed. An IDTA template's is `generate-idta-template.mjs` and
   `check-idta-seed-sync.mjs`. The 20 older rows of `idta_submodel_templates` were transcribed, and drift
   check 567 holds them to the generated ones.
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

**A vocabulary a site imports is outside this list.** Its rows are the site's, so nothing is
generated, nothing is verified against a source Aber ships, and no migration seeds it. What it must
satisfy instead (*Site vocabularies*, above): the seeded tables stay unwritable; the two site tables
are written only by Administrator functions behind the second factor, each filing an Audit Trail
row; the file is read by the one reader with the hostile-file rules; the database checks every row
again; a published standard is never added to `STANDARDS`; and a licensed definition leaves the site
only after an Administrator confirms the licence allows it.

## Settled decisions worth not relitigating

| Question | Settled answer |
|---|---|
| One `opcua_vocabulary` for seven specs, or one table each? | **One** — the PK is already `(companion_spec, name)` |
| Is `permitted_values` frozen like `metric_catalog.name`? | **No.** Nothing is configured against it, and a value set widens between editions; freezing it forces a version event for a non-breaking change. A published schema keeps its own copy as `enum`. `name` stays immutable |
| Where does nameplate data live? | **`device_nameplate`**, not `asset_config`, which ingestion rewrites from every DBIRTH |
| IDTA templates: own table or rows in `schemas`? | **Own table.** `schemas` is deployment state; templates are reference data |
| PackML as its own standard, or under OPC UA? | **Under OPC UA** (`companion_spec = OPC 30050 PackML`) — it is what the NodeSet was read from, and it avoids a table, a panel and a mirror module |
| Digital Nameplate version | IDTA 02006 **3.0**, its newest bug-fix release (3.0.3), which is what IDTA's repository says to use |
| Nested template elements: widen `idta_submodel_templates` or a new table? | **A new table, `idta_template_elements`**, keyed by the template and the element's path. The older table's key cannot hold them, and its key, CHECK and rows run on every boot (#489) |
| Which of a template's texts are taken? | **IDTA's own only.** A definition IEC CDD or ECLASS issued is left out of the kept file, and nothing is written in its place. The identifiers are kept (#489) |
| What can a site do with a listed template? | **Look it up.** Building a schema from one, and uploading one, are later parts of #489 |
| Seed 223P before the standard is published? | **Yes**, from `223p.ttl` `v1.0.0-2026`, with the migration header stating it is pre-publication |
| Does 223P follow the QUDT import? | **Not through 223P.** QUDT is a vocabulary of its own under its own licence (CC BY 4.0, credited to QUDT.org), read from its own release, 3.5.2, and not from the 3.2.1 the 223P ontology imports. It is seeded as `qudt_quantity_kinds` (every kind that is not deprecated, 1,126) and `qudt_units` (the 83 units MTConnect's names map to), in `0304`. A kind is the semantic id of a Custom or 223P metric and a further id of any metric. The five example 223P readings carry kinds that are rows (#942) |
| Is OPC 34100 (ECM) seeded too? | **No** — only Machinery/Energy; ECM is recorded as a dependency |
| Which `category` does a non-MTConnect metric get? | MTConnect's: `SAMPLE`, `EVENT` or `CONDITION`, translated per standard; 223P leaves it null |
| Which datatypes can the form create? | Double, Boolean and String; OPC UA integers become Double |
| What may a site import as a vocabulary, and why not a CSV? | **AAS ConceptDescriptions** with IEC 61360 content, from an `.aasx`, an AAS JSON environment or an AAS XML environment, and an OPC UA NodeSet2 file (#809). No CSV and no format of Aber's own: a custom file has no standard, and the simple route would be the one everybody took, so the standards would go unused. The import says what the file is. **A published standard** the site holds a copy of (name, edition, publisher) labels its metrics "ISO 22400-2:2014 (site licence)", files them under KeyPerformanceIndicators when it is ISO 22400, and never enters `STANDARDS`. **The site's own vocabulary** makes its metrics local extensions carrying the file's name. A metric links to the file and `standard` stays NULL, because a typed tag carries no evidence and a file's SHA-256, version and importer do. A licensed definition stays home until an Administrator confirms the licence allows sharing it (#808) |
| Which group do 223P metrics file under? | **`BMS`**, the one group registered under ASHRAE 223P (#456) |
| Where does VDA 5050 go: rows in `opcua_vocabulary`, or a table of its own? | **Its own, `vda5050_vocabulary`**, as 223P has one: it is not an OPC UA companion specification (#941) |
| Which VDA 5050 fields are rows? | The 24 scalar fields of the `state` message that are readings. No array (Sparkplug B has no composite type), no header, no order flow (#941) |
| Which group do VDA 5050 metrics file under, and why that spelling? | **`AGV`**, the word the pilot shopfloor uses; it cannot be confused with OPC 40010's robots, and the first spelling is permanent. The group says that 3.0 calls the vehicle a mobile robot (#941) |
| Does a VDA 5050 field fill in its unit? | **No.** The schema's keyword is the VDA's spelling, not an MTConnect UnitEnum name; units for these readings are #942's (#941) |
| What happens to `UTILIZATION`, `SCRAP_RATIO`, `MTBF` and `MTTR`? | **Deprecated in 1.9.0, removed no sooner than 1.10.0** (#940). `UTILIZATION` is not an ISO 22400 KPI, and no free source publishes the formulas of the other three. The four OEE KPIs stay, cited to OPC 40501-1 Annex C.2.4. A site that owns ISO 22400-2 can import it on the Vocabulary page. If that import does not ship in 1.9, the deprecation does not either |
| Is a 223P class a metric's semantic id? | **No.** 223P is a reference: a class names equipment, not a reading. Use starts a metric under `BMS` with no id, and the example readings carry QUDT quantity kinds (#461) |
| Should the platform COMPUTE ISO 22400 KPIs? | **No.** They arrive as published metrics — the `OEE/*` rows in `metric_catalog` are that route. None of the four OEE KPIs is computable from the catalogued metrics. Availability needs planned busy time and effectiveness needs planned run time per item, which OPC 40501-1 says come from an MES or ERP and not from the machine. Quality needs a good count beside the produced count, which a machine can publish (`PART_COUNT` `GOOD`, `PartsGood`), but OEE needs all three. Moving the arithmetic to Grafana or Node-RED does not change that. Was a roadmap item; retired |
| What is an OPC UA semantic id? | **The ExpandedNodeId the NodeSet publishes**, `nsu=<namespace URI>;i=<id>`, as `node_id` and `semantic_id` both, typed `ExpandedNodeId`. Not `<namespace URI><name>`, an IRI the OPC Foundation never issued (#458) |
