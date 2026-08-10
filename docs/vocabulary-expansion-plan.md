# Vocabulary Expansion and Submodel Templates — Implementation Plan

**Status:** direction agreed 2026-08-08; **nothing built**. Phase 0 is a gate and has not started.
**Date:** plan drafted 2026-08-08, written up 2026-08-09.

## Goal

Extend the standard vocabulary layer to cover the five asset classes on the target pilot shopfloor —
machining tools, robots, AGVs, 3D printers, and a BMS — and adopt IDTA Submodel templates so exported
AAS shells carry published semantic identifiers rather than locally minted ones.

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

## What the reconnaissance found

The extension points already exist, so most of this is additive rather than structural.

- `VocabularyPanel` takes a `tabs` array of descriptors
  ([VocabularyPanel.jsx:21](../frontend/src/components/common/VocabularyPanel.jsx#L21)) — adding a
  standard is one descriptor, not a refactor.
- `opcua_vocabulary` is keyed `(companion_spec, name)`
  ([0001:1415](../supabase/migrations/0001_baseline_schema.sql#L1415)), so three more OPC specs are
  **seed rows in the existing table**, not new tables.
- `scripts/sync-helm-chart-files.mjs` mirrors `supabase/migrations/*.sql` into the chart
  automatically, and CI runs it with `--check`.
- The AAS exporter emits `ExternalReference` / `GlobalReference` and **ignores `semantic_id_type`**
  ([index.ts:94-99](../supabase/functions/aas-export/index.ts#L94-L99)) — correct AAS V3, and it
  means IRDIs export with no code change. `semantic_id_type` is validation metadata here, not export
  input.

Current migration head is `0010_telemetry_aggregates.sql`, so the first new migration is **`0011`**.

---

## Phase 0 — Source acquisition and citation verification (gate)

Every seed is a **transcription**, which is why the existing vocabulary migration headers carry
⚠ VERIFY blocks. This phase is not optional, and it reorders everything else, because document
availability differs sharply:

| Source | Availability | Consequence |
|---|---|---|
| OPC 40501 Machine Tools, OPC 40450 Additive, OPC UA energy | Free from OPC Foundation, incl. NodeSet2 XML | Can start immediately |
| IDTA Submodel templates | Free download | Can start immediately |
| PackML (ISA-TR88.00.02) | Paid ISA document | Needs purchase before honest transcription |
| ASHRAE 223P | Paid, and publication status needs confirming | Needs purchase; may still be moving |

**Deliverable:** confirmed spec numbers, confirmed element/browse names, and a decision on each
`semantic_id` namespace. Nothing gets written into a migration from memory — that is the discipline
the OPC UA header already sets when it declines to assert numeric NodeIds.

## Phase 1 — OPC UA companion extensions (40501, 40450, energy)

Cheapest possible change, and it proves the pipeline end to end. No new table, no new `STANDARDS`
entry, no new panel.

1. Migration `0011_opcua_companion_extensions.sql` — `INSERT … ON CONFLICT (companion_spec, name)
   DO UPDATE`, idempotent because db-init replays every migration on boot.
2. New `metric_groups` rows with `standard = 'OPC UA'`. Register them **in the migration**, not on
   first use — `enforce_metric_group_spelling()` makes the first spelling permanent.
3. `semantic_id` = namespace URI + browse name, exactly as archived migration 0031 does.
4. Check `OPCUAVocabularyPanel` sections by `companion_spec`; with five specs it needs to, and that
   may be a small change.
5. Run `node scripts/sync-helm-chart-files.mjs` and commit the result.
6. `NOTIFY pgrst, 'reload schema'` at the end of the migration.

**Ship as one PR.** If this lands clean, Phases 3 and 4 are the same shape plus a table and a panel.

## Phase 2 — IDTA Digital Nameplate

The highest-value phase, and the only one that changes what the shells *are* rather than what they
can be named.

1. **Decide where nameplate data lives.** It is configuration, not telemetry — it never arrives in a
   DBIRTH. `asset_config` ([0001:802](../supabase/migrations/0001_baseline_schema.sql#L802)) is the
   natural home; new `devices` columns are the alternative. Do not make it metrics just because
   metrics are where values live.
2. `idta_submodel_templates` table, with the same RLS shape as the other vocabularies: RLS enabled,
   SELECT policy for `authenticated`, everything revoked from `PUBLIC`/`anon`, no write policy.
3. Seed Digital Nameplate's elements with their **published semanticIds**, typed `IRDI` where they
   are IRDIs.
4. Exporter: a `Nameplate` submodel in `supabase/functions/aas-export/`, `semanticId` = the template
   id, omitted entirely when the device has no nameplate data — the same rule the 3D model submodel
   already follows.
5. Tests against the vendored IDTA schema in `tests/schemas/`.

One latent bug worth noting but not necessarily fixing now: a `semantic_id_type = 'ModelReference'`
would also be emitted as `ExternalReference`, which would be wrong. Nothing sets it today.

## Phase 3 — PackML vocabulary and value domains

Two separable deliverables; do them in this order.

**3a — the vocabulary.** New `packml_vocabulary` table; a `STANDARDS.PACKML` entry plus a
`STANDARD_OPTIONS` row in [standards.js](../frontend/src/utils/standards.js); a `utils/packml.js`
selector module mirroring [utils/iso22400.js](../frontend/src/utils/iso22400.js); a
`PackMLVocabularyPanel.jsx` tab descriptor; and a fetch in [api.js](../frontend/src/api.js).
Semantic ids go under `LOCAL_SEMANTIC_NAMESPACE` — ISA and OMAC publish no concept IRIs.

**3b — permitted values.** The schema decision worth settling explicitly:

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

## Phase 4 — ASHRAE 223P

Same shape as 3a, with two differences that matter:

- **Real external IRIs**, so this is the second phase (after IDTA) where `semantic_id` stops being
  locally minted.
- **Gated on the BMS adapter, not on itself.** The vocabulary can land and be browsable with zero
  BACnet integration. Sequence it that way deliberately — per-point tagging is the long pole and
  should not block a shippable vocabulary.

---

## Definition of done — applies to every vocabulary

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

## Decisions to settle before code

| Decision | Options | Lean |
|---|---|---|
| One `opcua_vocabulary` for 5 specs? | Keep / split per spec | **Keep** — PK is already `(companion_spec, name)` |
| `permitted_values` frozen? | Freeze / mutable | **Freeze** — it is a wire contract; widening is a version event |
| Nameplate storage | `asset_config` / new `devices` columns | **`asset_config`** — it is config, and the table exists |
| IDTA templates | Own table / rows in `schemas` | **Own table** — `schemas` is deployment state, templates are reference data |
| PackML: full PackTags or states only? | Both / states only | **States only first** — the value-domain half is the higher-value half on this fleet |

## Sequencing

Phase 0 gates everything. Phases **1 and 2 are independent and unblocked** — they can run in
parallel and neither needs a paid document. Phase 3 waits on the ISA purchase; Phase 4 on ASHRAE
plus the BMS adapter.

Rough shape of the effort: Phase 1 measured in days; Phase 2 in a week or two, dominated by the
exporter and the nameplate storage decision; Phase 3 about the same, with the immutability-trigger
decision being the careful part; Phase 4 dominated entirely by tagging effort rather than by code.

**Natural first PR: Phase 1.** Small enough to review properly, and it will flush out anything this
plan has wrong about the panel wiring.
