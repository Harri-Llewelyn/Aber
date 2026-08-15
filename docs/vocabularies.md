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

### Scope boundaries, already settled

- **Inferred ISO 22400 KPIs are deferred, not rejected.** Computing OEE needs planned busy time,
  planned run time per item, and good/scrap disposition. None of those are telemetry, and storing
  them is what would turn this platform into an MES. PackML state-time accumulation is the route
  that later makes OEE *arithmetic over existing metrics* rather than inference. Do not propose
  storing schedules, orders or routings.
- **AGVs are the one gap the five vocabularies leave, and VDA 5050 does not fill it here.** VDA 5050
  is a complete bidirectional MQTT interface with its own topic tree keyed on
  manufacturer + serialNumber, so it fails the vocabulary test and would introduce a second identity
  path competing with `sparkplug_id`. If AGV telemetry is needed, take only the `state` message's
  scalar fields (`batteryCharge`, `driving`, `paused`, `velocity`, `operatingMode`, `lastNodeId`) as
  a vocabulary and put the protocol in a Node-RED edge adapter republishing to `spBv1.0/#`. The same
  verdict applies to BACnet for the BMS. AGV *position* is telemetry, never `devices.cell_id` —
  writing it there fires `log_digital_thread_event()` on every update.

## Extension points

Adding a standard is additive rather than structural, because of four properties worth knowing
before proposing a change:

- `VocabularyPanel` takes a `tabs` array of descriptors
  ([VocabularyPanel.jsx:21](../frontend/src/components/common/VocabularyPanel.jsx#L21)) — a
  standard is one descriptor, not a refactor.
- `opcua_vocabulary` is keyed `(companion_spec, name)`
  ([0001:1415](../supabase/migrations/0001_baseline_schema.sql#L1415)), so further OPC specs are
  **seed rows in the existing table**, not new tables.
- `scripts/sync-helm-chart-files.mjs` mirrors `supabase/migrations/*.sql` into the chart
  automatically, and CI runs it with `--check`.
- The AAS exporter emits `ExternalReference` / `GlobalReference` and **ignores `semantic_id_type`**
  ([index.ts:94-99](../supabase/functions/aas-export/index.ts#L94-L99)) — correct AAS V3, and it
  means IRDIs export with no code change. `semantic_id_type` is validation metadata here, not export
  input.

---

## Source acquisition and citation verification

Every seed is a **transcription**, which is why the vocabulary migration headers carry ⚠ VERIFY
blocks. Every identity, namespace URI and version below was read out of the authoritative
machine-readable source, not from prose. Nothing here required a paid document.

### Verified identities and namespaces

The three OPC entries were parsed directly from the NodeSet2 XML in
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

NodeSet file paths, for the generator to pin (note the inconsistent capitalisation of `NodeSet2` vs
`Nodeset2` upstream — the Additive path 404s if you guess it):

```
MachineTool/Opc.Ua.MachineTool.NodeSet2.xml
AdditiveManufacturing/Opc.Ua.AdditiveManufacturing.Nodeset2.xml
Machinery/Energy/Opc.Ua.Machinery.Energy.NodeSet2.xml
PackML/Opc.Ua.PackML.NodeSet2.xml
```

**PackML is no longer a paid dependency.** The plan originally treated ISA-TR88.00.02-2022 as a hard
gate, because ISA and OMAC publish no concept IRIs and the document is paywalled. It is
published as an OPC UA companion specification — **OPC 30050** — whose NodeSet carries the full
state model *and* per-state descriptions under the MIT licence. PackML is therefore unblocked, and
gets **better** ids than first assumed: external IRIs rather than locally minted ones. See
*PackML states and value domains* for what this collapses.

**The correction that matters: OPC 40450 is not Additive Manufacturing.** OPC 40450-1 is *OPC UA for
Joining Systems — Part 1: Base* (tightening, riveting, flow drill fastening, gluing). Additive is
**OPC 40540**. Seeding 40450 would have produced a migration citing a real specification for the
wrong domain — exactly the failure the ⚠ VERIFY discipline exists to prevent, and one that would
have been very hard to spot later because both numbers resolve to genuine OPC documents.

**The clarification: "OPC UA energy" resolves to two documents, and the Machinery
one.** `OPC 40001-4` is the Machinery-series part and is the right fit, because this codebase
already carries OPC 40001 Machinery and OPC 40010 Robotics. It is built on **OPC 34100** *OPC UA for
Energy Consumption Management* v1.0.1, a joint ODVA / OPC Foundation / PI / VDMA specification —
worth reading, but 40001-4 is what gets seeded.

**Two further findings that change sequencing:**

- **ASHRAE 223P is not blocked either, and the ontology is explicitly Apache-2.0.** The standard
  document is still in public review, but the ontology is openly published and **declares its own
  licence in-band**:

  ```turtle
  <http://data.ashrae.org/standard223/1.0/model/all> a owl:Ontology ;
      dcterms:license <http://www.apache.org/licenses/LICENSE-2.0> ;
      dcterms:rights "Copyright 2026 ASHRAE" ;
      dcterms:rightsHolder "ASHRAE" ;
      owl:versionInfo "v1.0.0-2026" .
  ```

  That is the same footing as MTConnect's Apache-2.0, asserted by the rights holder rather than
  inferred. **Decision taken: seed it** (see *ASHRAE 223P* for the pre-publication caveat).

  The artefact to pin is
  `open223/defs.open223.info` → `ontologies/223p.ttl` (536 KB), version `v1.0.0-2026`.
  **Do not use `open223/Standard223`** — the obvious-looking `standard223-core.ttl` there is a
  35-byte placeholder, not the ontology.

  It parses to **563 `s223:Class` concepts and 49 relations**, each with `rdfs:label` and mostly
  `rdfs:comment` — name, label and description all present, which is exactly the shape a vocabulary
  row needs.
- **PackML turned out not to be gated at all.** ISA-TR88.00.02-2022 is paid, and the 17 state names
  being widely quoted in vendor documentation is not the same as verifying them against a source.
  But the state model is *also* published as OPC 30050 under the MIT licence, which is a real source
  that can be read — so the paid document is not needed. See the note above and *PackML states and value domains*.

### Generate the OPC seeds; do not transcribe them

**This is the finding that most changes the OPC work.** The transcription risk that made verification a gate
does not apply to the three OPC specs at all, because their vocabularies are published as
machine-readable NodeSet2 XML. The repository already has the pattern and the precedent:
[`scripts/generate-mtconnect-vocabulary.mjs`](../scripts/generate-mtconnect-vocabulary.mjs) exists
because "transcribing it by hand would be both error-prone and unauditable, so the migration is
generated and the generator is committed alongside it", with
`scripts/check-mtconnect-seed-sync.mjs` keeping the seed honest afterwards.

Do the same here: a `scripts/generate-opcua-vocabulary.mjs` that parses the three NodeSets and emits
the seed rows. Bumping to a newer companion-spec release then becomes a version bump and a re-run,
and the ⚠ VERIFY block can state that the values were extracted mechanically rather than read.

**Licensing permits it.** Each NodeSet carries the **OPC Foundation MIT License 1.00** in its header
— "permission to use, copy, modify, merge, publish, distribute" — directly analogous to the
Apache-2.0 note the MTConnect generator relies on. As with MTConnect, this covers the *vocabulary*,
not a conformance claim.

A first extraction over the three files confirms it works: 62 / 6 / 4 ObjectTypes respectively, and
the variable members resolve with browse names and datatypes (`ChannelModifierType/DryRun` →
`Boolean`, `IMassFlowType/MassFlowRate` → `Float`). The generator will need to walk nested
components rather than direct members only — MachineTool declares 356 `UAVariable` nodes against 104
reachable one level down.

Two things the generator must handle that the MTConnect one does not:

- **The Energy model imports `http://opcfoundation.org/UA/ECM/`**, which is OPC 34100 Energy
  Consumption Management. Decide whether ECM concepts are in scope or whether only the
  `Machinery/Energy` namespace is seeded. Recommendation: seed only `Machinery/Energy` and record
  ECM as a dependency, or `companion_spec` stops meaning one document.
- **`companion_spec` strings must be chosen once.** Existing rows read `OPC 40001 Machinery`, so
  follow that shape: `OPC 40501 Machine Tools`, `OPC 40540 Additive Manufacturing`,
  `OPC 40001-4 Machinery Energy`. `enforce_metric_group_spelling()` makes the first spelling of the
  matching `metric_groups` rows permanent.

### What verification changed

**Nothing outstanding, nothing to buy, no decisions left open.** All six vocabularies come from an
open, machine-readable source whose licence permits redistribution in a derived work, and every one
of those licences was read rather than assumed:

| Source | Licence | Asserted by |
|---|---|---|
| OPC 40501-1, 40540, 40001-4, 30050 NodeSets | OPC Foundation MIT License 1.00 | file header |
| IDTA 02006-3-0-1 Digital Nameplate | free IDTA publication | IDTA content hub |
| ASHRAE 223P ontology | Apache-2.0 | `dcterms:license` in the ontology |

Everything below is implementable without a further acquisition step.

## OPC UA companion extensions (40501-1, 40540, 40001-4)

**Delivered 2026-08-10**: 35 `opcua_vocabulary` rows and 8 `metric_groups` rows, generated by
`scripts/generate-opcua-vocabulary.mjs` and guarded by `scripts/check-opcua-seed-sync.mjs` in CI.

Two deliberate departures from the original design:

- **The seed is curated, not dumped.** The NodeSets carry almost no descriptions — MachineTool
  declares 356 variables of which 18 have one, Machinery/Energy has 87 and none — so a bulk
  extraction would have produced hundreds of rows with a NULL description, and `VocabularyPanel`
  searches the tooltip as well as the name. The generator instead *verifies* a curated entry list
  against the NodeSet and reads the datatype from it, failing if an ObjectType, a member or the
  pinned specification version is not what it expects.
- **The rows went into `0002_seed_data.sql` between markers, not into a new `0011`.** That is where
  the existing `opcua_vocabulary` rows live, and it is what the MTConnect generator already does; a
  migration would have split one table's seed across two files.

No i3X `STANDARD_NAMESPACES` entry was needed: `standard` stays `'OPC UA'`.

Original plan follows.

Cheapest possible change, and it proves the pipeline end to end. No new table, no new `STANDARDS`
entry, no new panel.

1. `scripts/generate-opcua-vocabulary.mjs` emits migration
   `0011_opcua_companion_extensions.sql` — `INSERT … ON CONFLICT (companion_spec, name) DO UPDATE`,
   idempotent because db-init replays every migration on boot. Commit generator and output together,
   and add a seed-sync check mirroring `check-mtconnect-seed-sync.mjs`.
2. New `metric_groups` rows with `standard = 'OPC UA'`. Register them **in the migration**, not on
   first use — `enforce_metric_group_spelling()` makes the first spelling permanent.
3. `semantic_id` = namespace URI + browse name, exactly as archived migration 0031 does — using the
   three URIs confirmed above.
4. Check `OPCUAVocabularyPanel` sections by `companion_spec`; with five specs it needs to, and that
   may be a small change.
5. Run `node scripts/sync-helm-chart-files.mjs` and commit the result.
6. `NOTIFY pgrst, 'reload schema'` at the end of the migration.

**Ship as one PR.** If this lands clean, Phases 3 and 4 are the same shape plus a table and a panel.

## IDTA Digital Nameplate

**Delivered 2026-08-10**: migration `0011_device_nameplate.sql` (the `idta_submodel_templates`
vocabulary seeded with all 20 IDTA 02006 v3.0 top-level elements, and a `device_nameplate` table),
plus the AAS exporter retrofit and its tests.

Three corrections to the original design, all found by inspection:

- **`asset_config` was the wrong home**, though it was the obvious one. That table is ingestion-owned
  — `ingestion.py` upserts it from every DBIRTH keyed `(asset_id, metric_name)` — so operator-typed
  values would be indistinguishable from device-asserted ones and churned on every rebirth. A
  dedicated `device_nameplate` table keeps the provenance distinction that a nameplate needs.
- **The exporter already had a Nameplate submodel.** This phase was a retrofit, not a build: the
  existing one carried no semanticId on the submodel or on any property.
- **The submodel deliberately does not claim the IDTA template id.** Element-level identifiers only.
  Naming `https://admin-shell.io/idta/nameplate/3/0/Nameplate` would assert conformance to a
  template whose mandatory elements include an `AddressInformation` collection this platform does
  not model, and a consumer trusting the id would validate the shell against the template and fail.

Values resolve **device-first**, joined on `semantic_id` rather than metric name: where a device
publishes OPC 40001 Machinery `Manufacturer` / `SerialNumber` / `YearOfConstruction`, that is what
the shell reports, and the table fills the gaps.

**The editor is a modal on the Devices tab**, in the same per-device `ActionMenu` as Asset Config,
Documents and the two AAS exports — placed directly above the exports because it is the only entry
there that changes what they contain. It is deliberately *not* on the Schemas page: that page is
entirely type-level (what a metric may be named, what a standard defines), and a nameplate is a
fact about one physical asset.

The form shows fields the device publishes for itself as **read-only, with the device's value**.
That is not a limitation but the point: the exporter prefers a published value, so an editable
field would accept a serial number, save it, and never show it in the shell with nothing on screen
explaining why.

**The Standard Vocabulary Reference now has a page of its own** (`/vocabulary`), split out of
Schemas. The seam is between things you *do* — the schema registry and the metric catalog, which
are this deployment's state — and things you *look up*, which is the half that grows whenever a
standard is adopted rather than when anyone here decides it should. PackML and 223P both add to it.

**Use still works across the split.** The Vocabulary page hands the Schemas page an *identifier*
(`{ standard, name }`, or `{ standard, companionSpec, name }` for OPC UA, whose vocabulary is keyed
on the pair), and Schemas resolves it against the vocabularies it already loads for its type picker.
The rules that turn a vocabulary row into a metric therefore stay in one place instead of being
copied onto the new page.

Original plan follows.

The highest-value phase, and the only one that changes what the shells *are* rather than what they
can be named.

1. **Decide where nameplate data lives.** It is configuration, not telemetry — it never arrives in a
   DBIRTH. `asset_config` ([0001:802](../supabase/migrations/0001_baseline_schema.sql#L802)) is the
   natural home; new `devices` columns are the alternative. Do not make it metrics just because
   metrics are where values live.
2. `idta_submodel_templates` table, with the same RLS shape as the other vocabularies: RLS enabled,
   SELECT policy for `authenticated`, everything revoked from `PUBLIC`/`anon`, no write policy.
3. Seed Digital Nameplate's elements with their **published semanticIds**, typed `IRDI` where they
   are IRDIs. **Verification confirmed the 3.0 element list**, and it is a genuine mix — most elements
   carry IEC CDD / ECLASS IRDIs (`ManufacturerName` → `0112/2///61987#ABA565#009`, `SerialNumber` →
   `0112/2///61987#ABA951#009`, `AssetSpecificProperties` → `0173-1#02-ABI218#003/0173-1#01-AGZ672#004`),
   while a few are admin-shell.io IRIs (`UniqueFacilityIdentifier`, and `AddressInformation`, which
   still points at the **1/0** ContactInformations namespace even in the 3.0 template). So
   `semantic_id_type` genuinely varies per row rather than per submodel.

   **Version decided: IDTA 02006 v3.0**, semanticId `https://admin-shell.io/idta/nameplate/3/0/Nameplate`.
   2.0 (`https://admin-shell.io/zvei/nameplate/2/0/Nameplate`) is what much existing tooling still
   emits and 4.0 is in development, but the version is part of the id, so a choice cannot be
   deferred and the current published release is the defensible one.
4. Exporter: a `Nameplate` submodel in `supabase/functions/aas-export/`, `semanticId` = the template
   id, omitted entirely when the device has no nameplate data — the same rule the 3D model submodel
   already follows.
5. Tests against the vendored IDTA schema in `tests/schemas/`.

One latent bug worth noting but not necessarily fixing now: a `semantic_id_type = 'ModelReference'`
would also be emitted as `ExternalReference`, which would be wrong. Nothing sets it today.

## PackML states and value domains (OPC 30050)

**The vocabulary half**: 16 rows under `companion_spec = 'OPC 30050 PackML'`, a `PackML`
metric group, and a fourth entry in `scripts/generate-opcua-vocabulary.mjs`. It collapsed exactly as
predicted — no new table, no `STANDARDS.PACKML`, no panel, no mirror module, no i3X entry.

Two things the fourth NodeSet forced that the first three had not:

- **The generator now refuses STRUCTURE datatypes.** It previously mapped any
  specification-defined DataType to `String` on the assumption it was an enumeration — true for
  MachineTool and Additive, false for PackML, which declares `PackMLCountDataType` and four more
  structures. Sparkplug B has no composite type, so flattening one to a string would have produced
  a row that looks ordinary and cannot be published. Enumeration and Structure are told apart by
  the reverse `HasSubtype` reference (`i=29` vs `i=22`), and a structure now stops the build.
- **The current PackML state is not in this vocabulary, deliberately.** `CurrentState` belongs to
  the inherited `StateMachineType` rather than to anything OPC 30050 declares, so there is nothing
  to verify against. Its *values* — the 17 TR88 states, which OPC 30050 does declare with their
  canonical `StateNumber`s — are a value domain, covered below.

**The value-domain half**: migration `0012_metric_permitted_values.sql`, the derived finding in
`utils/deviceTags.js`, and its wiring into the Devices tab.

**The immutability decision came out the other way from the obvious one.**
`permitted_values` is **not** frozen. The argument for freezing — a device is configured against
its value set the way it is configured against its name — does not survive asking what the column
is. `name` and `datatype` are a wire contract: a device is physically configured against them and
changing one re-points historical telemetry. `permitted_values` is a transcribed assertion about a
standard that nothing is configured against — no device reads it, ingestion never consults it, and
no historical row moves when it changes. Freezing it would mean a mistyped value could only be
corrected by deprecating the metric and re-provisioning every device that publishes it, to fix a
string that never left the database. That is exactly the trade migration 0029 already refused for
`semantic_id`, in the same table, for the same reason. Standards also *add* values between
editions, so a frozen set would go stale by the standard's action rather than anyone's mistake.

0012 therefore carries its own mutability probe, mirroring 0029's, so a later edit that freezes the
column fails the migration instead of shipping it.

Two separable deliverables; do them in this order.

**The vocabulary is a fourth NodeSet rather than a new subsystem.** Verification found
that PackML is published as an OPC UA companion specification — **OPC 30050**, *OPC UA for PackML —
Common Object Model: PackML*, namespace `http://opcfoundation.org/UA/PackML/`, v1.01 (2020-10-08),
under the same OPC Foundation MIT License 1.00 as the other three NodeSets. That collapses almost
all of this deliverable:

- **No `packml_vocabulary` table, no `STANDARDS.PACKML`, no `PackMLVocabularyPanel`, no
  `utils/packml.js`, no i3X namespace entry.** These are `opcua_vocabulary` rows with
  `companion_spec = 'OPC 30050 PackML'`, exactly as OPC 40001 and OPC 40010 already are — add the
  fourth NodeSet to the OPC generator, and the panel sections it by `companion_spec` for free.
- **Semantic ids are real IRIs**, not locally minted. The earlier position — mint under
  `LOCAL_SEMANTIC_NAMESPACE` because ISA and OMAC publish no concept IRIs — is superseded: the OPC
  UA representation does publish them, and the rule against minting an id that impersonates a
  standard now resolves in favour of the external namespace.
- **`standard` stays `'OPC UA'`.** Seeding from OPC 30050 and then labelling the provenance
  `PackML` would assert a source that was not read. The alternative — a genuine `PackML` standard —
  is available if the fleet makes the distinction worth surfacing in the metric form, but it costs
  the whole subsystem above and buys a label.

The state model extracts cleanly, with the canonical state numbers as `StateNumber` properties:
1 Clearing, 2 Stopped, 3 Starting, 4 Idle, 5 Suspended, 6 Execute, 7 Stopping, 8 Aborting,
9 Aborted, 10 Holding, 11 Held, 12 Unholding, 13 Suspending, 14 Unsuspending, 15 Resetting,
16 Completing, 17 Complete — plus 18 Running and 19 Cleared, which are sub-state-machine states of
the OPC UA model rather than TR88 states, and should be seeded as such or not at all. The NodeSet
also carries per-state `Description` prose, so the `description` column does not have to be invented.

**⚠ VERIFY must say what was actually read.** The source is OPC 30050, *not* ISA-TR88.00.02-2022.
It is a faithful OPC UA representation of the TR88 state model, but it is a different document by a
different body, and the header has to say so — the same honesty the OPC UA header already applies
when it declines to assert numeric NodeIds.

PackTags are also modelled (`PackMLCountDataType`, `PackMLDescriptorDataType`, `PackMLAlarmDataType`,
`PackMLProductDataType`, `ProductionMaintenanceModeEnum`), so the "states only first" decision is now
a scoping choice rather than a consequence of what could be obtained.

**Permitted values.** The schema decision worth stating explicitly:

- Add `permitted_values` to `metric_catalog` (JSONB or `TEXT[]`).
- **Does `enforce_metric_catalog_immutability()` widen to cover it?** It currently freezes only
  `name` and `datatype` ([0001:303](../supabase/migrations/0001_baseline_schema.sql#L303)).
  Recommendation: **yes, freeze it** — a device is configured against the value set the same way it
  is against the name, and widening a set then becomes a schema-version event, which there is
  already machinery for. Guard: archived migration 0029's probe asserts `semantic_id` stays
  updatable on `metric_catalog`, so any widening must be written carefully or that migration fails.
- Backfill the values CLAUDE.md already documents in prose: `Controller/EXECUTION`'s five,
  `Controller/EMERGENCY_STOP`'s two.
- New derived finding in [utils/deviceTags.js](../frontend/src/utils/deviceTags.js):
  *out-of-vocabulary value*, computed at read time from last telemetry and stored nowhere — the same
  pattern as Unmodelled.

## ASHRAE 223P

**Delivered 2026-08-10**: migration `0013_ashrae223_vocabulary.sql` with **640 concepts** (576
Class, 60 Relation, 3 AbstractClass, 1 Concept) generated by
`scripts/generate-ashrae223-vocabulary.mjs`, guarded by `scripts/check-ashrae223-seed-sync.mjs`,
plus `STANDARDS.ASHRAE223`, `utils/ashrae223.js`, a Vocabulary-page tab, an API route and the i3X
namespace entry.

Three things worth recording:

- **A real Turtle tokeniser, not a regex — and the trap was concrete.** `rdfs:comment` appears
  inside the nested `sh:property [ … ]` blank nodes as a SHACL constraint message, several times per
  class. A scan that found `rdfs:comment` after a subject would have described `s223:Fan` as *"A
  `Fan` shall have at least one outlet using the medium `Fluid-Air`"*. The parser tracks bracket
  depth and reads predicates only at the top level of a subject block.
- **Whitespace is collapsed in descriptions**, because several comments are hard-wrapped in the
  ontology and a newline inside a SQL string breaks the one-statement-per-line shape the digest,
  the seed-sync check and every `git diff` of that file rely on.
- **One `metric_groups` row, not 640.** `enforce_metric_group_spelling()` makes the first spelling
  permanent, so registering a group per concept — for a standard that is not yet published — would
  permanently fix a naming the standard may still change. BMS points are `Building/<concept>`.

**A consequence to watch:** the chart's `migrations` ConfigMap is now **802 KiB, 78% of the 1 MiB
limit**, and `sync-helm-chart-files.mjs` warns about it. 0013 alone is 334 KiB. The next large
vocabulary will not fit, and the fix at that point is to stop shipping reference data as a
ConfigMap rather than to trim it.

**Decided: seed from the open223 ontology**, `ontologies/223p.ttl` at version `v1.0.0-2026`, pinned
in the generator the way `SCHEMA_VERSION` is pinned in the MTConnect one.

This is the only new vocabulary that needs a table of its own — a `s223_vocabulary` (or
`ashrae223_vocabulary`) keyed on the concept name, plus a `STANDARDS.ASHRAE223` entry and
`STANDARD_OPTIONS` row in [standards.js](../frontend/src/utils/standards.js), a `utils/ashrae223.js`
mirror module, a panel tab descriptor, a fetch in [api.js](../frontend/src/api.js), and a
`STANDARD_NAMESPACES` entry in [i3x/address_space.py](../i3x/address_space.py). The other four all
fold into `opcua_vocabulary`; this one is not an OPC UA companion specification and pretending
otherwise would misstate its provenance.

Five things that matter, three of them specific to this source:

- **Real external IRIs** under `http://data.ashrae.org/standard223#`, so this is the second
  vocabulary (after IDTA) where `semantic_id` stops being locally minted.
- **Gated on the BMS adapter, not on itself.** The vocabulary can land and be browsable with zero
  BACnet integration. Sequence it that way deliberately — per-point tagging is the long pole and
  should not block a shippable vocabulary.
- **The standard is not yet final.** The concept IRIs come from a pre-publication ontology release,
  so the migration header must say exactly that, and a concept moving before publication is a
  foreseeable event rather than a surprise. This is the one vocabulary here where
  `enforce_metric_group_spelling()` making the first spelling permanent is a real risk — prefer
  registering the small set of `metric_groups` actually used over registering one per concept.
- **It is Turtle/SHACL, not XML**, so the generator needs a real RDF parse rather than the
  ElementTree walk the NodeSets allow. A line-oriented regex over 536 KB of Turtle will appear to
  work and then silently miss multi-line literals and blank-node structures. Decide the parser
  deliberately — an `n3`/`rdf-parse` dependency for a `.mjs` generator, or a Python generator using
  `rdflib`, which the repository already has Python for.
- **Seed only the `s223:` namespace.** The ontology `owl:imports` QUDT
  (`http://qudt.org/3.2.1/shacl/qudt-all`) for quantity kinds and units. Following that import
  pulls in a second vocabulary, several times the size, under a different licence that would need
  its own check. Units are already handled by MTConnect's `units` vocabulary; do not open this.

---

## Definition of done — applies to every vocabulary

> Kept here as the authoritative list. The same checklist is reachable from
> [`supabase/README.md`](../supabase/README.md#adding-a-vocabulary).

1. Migration is **idempotent** (`ON CONFLICT … DO UPDATE`); db-init replays it every boot.
2. RLS enabled, SELECT policy for `authenticated`, `REVOKE ALL FROM PUBLIC, anon`, no write policy.
3. `metric_groups` rows registered in the migration, carrying `standard` provenance.
4. `NOTIFY pgrst, 'reload schema'`.
5. `node scripts/sync-helm-chart-files.mjs` run and committed (CI checks it with `--check`).
6. Migration header carries a ⚠ VERIFY block naming what was and was not confirmed against the
   source document.
7. Frontend mirror module plus unit tests; check whether `scripts/check-docs-drift.mjs` or
   `scripts/check-mirror-drift.mjs` needs a new pair.
8. `docs/openapi.yaml` updated if any endpoint shape changes.
9. **A `STANDARD_NAMESPACES` entry in [`i3x/address_space.py`](../i3x/address_space.py).** This
   obligation post-dates the original vocabulary work — the i3X server landed after it, and
   it maps `metric_catalog.standard` onto an i3X Namespace. A new standard with no entry there is
   **silently omitted from `GET /namespaces`**: the endpoint answers 200 with a shorter list, which
   reads as "this deployment does not use that standard". The key must be the exact `standard`
   string the migration writes. `TestStandardNamespaces` in `i3x/test_i3x_service.py` pins the key
   set against `STANDARDS` in `standards.js`, so adding a standard there without a namespace fails
   the suite — but only if the new standard is added to `standards.js`, which the panel wiring requires
   anyway.


## Settled decisions worth not relitigating

| Question | Settled answer |
|---|---|
| One `opcua_vocabulary` for five specs, or one table each? | **One** — the PK is already `(companion_spec, name)` |
| Is `permitted_values` frozen like `metric_catalog.name`? | **No.** A value set widens as a device gains modes; freezing it forces a version event for a non-breaking change. `name` stays immutable |
| Where does nameplate data live? | `asset_config` — it is config, and the table exists |
| IDTA templates: own table or rows in `schemas`? | **Own table.** `schemas` is deployment state; templates are reference data |
| PackML as its own standard, or under OPC UA? | **Under OPC UA** (`companion_spec = OPC 30050 PackML`) — it is what the NodeSet was read from, and it avoids a table, a panel and a mirror module |
| Digital Nameplate version | IDTA 02006 **3.0** |
| Seed 223P before the standard is published? | **Yes**, from `223p.ttl` `v1.0.0-2026`, with the migration header stating it is pre-publication |
| Does 223P follow the QUDT import? | **No** — separate vocabulary, separate licence, and units are already covered |
| Is OPC 34100 (ECM) seeded too? | **No** — only Machinery/Energy; ECM is recorded as a dependency |
