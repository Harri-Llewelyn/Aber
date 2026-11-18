import {
  buildConceptDescriptions,
  buildEnvironment,
  type ConceptDefinition,
  type DeviceRecord,
  isKpiMetric,
  loadDeviceRecord,
  type SiteConcept,
  siteDefinitionFor,
  siteFileLabel,
  type SiteVocabularyRef,
} from "./shell.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

// deno-lint-ignore no-explicit-any
type Anything = any;

const KPI = "https://example.org/kpi/OEE";
const OTHER = "https://example.org/kpi/Scrap";
const LICENSED = "Licensed definition text, as the bought standard words it.";

const ISO_FILE: SiteVocabularyRef = {
  id: "v-iso",
  name: "ISO 22400 KPIs",
  kind: "published_standard",
  standard_name: "ISO 22400-2",
  standard_edition: "2014",
  definitions_shareable: false,
};
const OWN_FILE: SiteVocabularyRef = {
  id: "v-own",
  name: "Group naming standard",
  kind: "site_own",
  standard_name: null,
  standard_edition: null,
  definitions_shareable: false,
};

const concept = (id: string, name: string, definition: string | null, file: SiteVocabularyRef): SiteConcept => ({
  semantic_id: id,
  preferred_name: name,
  definition,
  site_vocabularies: file,
});

const metric = (id: string, name: string, semanticId: string | null, extra = {}) => ({
  id,
  name,
  semantic_id: semanticId,
  datatype: 10,
  units: "PERCENT",
  description: "The catalog's description, which may be a copy of the licensed text.",
  standard: null,
  deprecated: false,
  ...extra,
});

/** The ConceptDescription an id gets, read back from the serialised environment. */
function descriptionOf(rows: Parameters<typeof buildConceptDescriptions>[1], id: string): Anything {
  const [cd] = JSON.parse(JSON.stringify(buildConceptDescriptions([id], rows)));
  const content = cd.embeddedDataSpecifications[0].dataSpecificationContent;
  return { name: content.preferredName[0].text, definition: content.definition[0].text, idShort: cd.idShort };
}

const base = (catalog: Record<string, unknown>[], siteConcepts: SiteConcept[], definitions: ConceptDefinition[] = []) => ({
  catalog,
  templates: [],
  schemas: [],
  definitions,
  siteConcepts,
});

Deno.test("an id of a vocabulary whose definitions are not shared takes the imported name and defers its definition", () => {
  const rows = base([metric("m1", "Line/OEE", KPI)], [concept(KPI, "Overall equipment effectiveness", LICENSED, ISO_FILE)]);
  assert.equal(descriptionOf(rows, KPI), {
    name: "Overall equipment effectiveness",
    definition: "Overall equipment effectiveness, as ISO 22400-2:2014 defines it.",
    idShort: "Overall_equipment_effectiveness",
  });
});

Deno.test("it never falls back to the catalog's description, whatever the metrics agree on", () => {
  const rows = base(
    [metric("m1", "Line/OEE", KPI), metric("m2", "Cell/OEE", KPI)],
    [concept(KPI, "OEE", LICENSED, ISO_FILE)],
  );
  const { definition } = descriptionOf(rows, KPI);
  assert.equal(definition.includes("catalog"), false);
  assert.equal(definition.includes(LICENSED), false);
  // The same id with no site vocabulary behind it is still defined by the metrics' agreed text.
  assert.equal(
    descriptionOf(base(rows.catalog, []), KPI).definition,
    "The catalog's description, which may be a copy of the licensed text.",
  );
});

Deno.test("once the Administrator confirms the licence, the imported definition is the text", () => {
  const shared = { ...ISO_FILE, definitions_shareable: true };
  const rows = base([metric("m1", "Line/OEE", KPI)], [concept(KPI, "OEE", LICENSED, shared)]);
  assert.equal(descriptionOf(rows, KPI), { name: "OEE", definition: LICENSED, idShort: "OEE" });
});

Deno.test("a shared concept with no text defers to the file, and does not use the catalog's", () => {
  const shared = { ...OWN_FILE, definitions_shareable: true };
  const rows = base([metric("m1", "Line/Group", KPI)], [concept(KPI, "Group metric", null, shared)]);
  assert.equal(descriptionOf(rows, KPI).definition, "Group metric, as Group naming standard defines it.");
});

Deno.test("a site's own vocabulary is named by its file, and a published standard by its citation", () => {
  assert.equal(siteFileLabel(OWN_FILE), "Group naming standard");
  assert.equal(siteFileLabel(ISO_FILE), "ISO 22400-2:2014");
  assert.equal(siteFileLabel({ ...ISO_FILE, standard_edition: null }), "ISO 22400-2");
  assert.equal(siteFileLabel(undefined), "the site's vocabulary");
});

Deno.test("a seeded standard that defines the id comes first, as in concept_definitions", () => {
  const seeded: ConceptDefinition = { semantic_id: KPI, name: "Seeded", definition: "The standard's text.", standard: "ISO 22400" };
  const rows = base([], [concept(KPI, "Imported", LICENSED, ISO_FILE)], [seeded]);
  assert.equal(descriptionOf(rows, KPI).definition, "The standard's text.");
  assert.equal(siteDefinitionFor(KPI, seeded, rows.siteConcepts), undefined);
  // The view's own site arm has no standard, so it does not hide the concept's file from the rule.
  const siteArm: ConceptDefinition = { ...seeded, standard: null };
  assert.equal(siteDefinitionFor(KPI, siteArm, rows.siteConcepts)?.name, "Imported");
});

Deno.test("an id nobody carries as a metric is still defined by its file", () => {
  const rows = base([], [concept(OTHER, "Scrap ratio", LICENSED, OWN_FILE)]);
  assert.equal(descriptionOf(rows, OTHER).name, "Scrap ratio");
  assert.equal(descriptionOf(rows, OTHER).definition, "Scrap ratio, as Group naming standard defines it.");
});

Deno.test("rows with no site concepts, or an id that is not in them, are described as before", () => {
  const rows = base([metric("m1", "Line/OEE", KPI)], []);
  assert.equal(descriptionOf(rows, KPI).name, "OEE");
  const withoutField = { ...rows } as Anything;
  delete withoutField.siteConcepts;
  assert.equal(descriptionOf(withoutField, KPI).name, "OEE");
  assert.equal(descriptionOf(base(rows.catalog, [concept(OTHER, "Scrap", LICENSED, OWN_FILE)]), KPI).name, "OEE");
});

// ---- The KPI split ---------------------------------------------------------------------------

Deno.test("a metric started from a published standard named ISO 22400 is a KPI, by prefix", () => {
  const linked = metric("m1", "Line/OEE", KPI, { site_vocabulary_id: "v-iso" });
  assert.equal(isKpiMetric(linked, [ISO_FILE]), true);
  assert.equal(isKpiMetric(linked, [{ ...ISO_FILE, standard_name: "ISO 22400" }]), true);
  assert.equal(isKpiMetric(linked, [{ ...ISO_FILE, standard_name: "ISO 9001" }]), false);
  assert.equal(isKpiMetric(linked, [{ ...ISO_FILE, standard_name: "The ISO 22400 notes" }]), false);
});

Deno.test("a site's own vocabulary, an unlinked metric and a missing file are not KPIs", () => {
  assert.equal(isKpiMetric(metric("m1", "A/B", KPI, { site_vocabulary_id: "v-own" }), [OWN_FILE]), false);
  assert.equal(isKpiMetric(metric("m2", "A/C", KPI), [ISO_FILE]), false);
  assert.equal(isKpiMetric(metric("m3", "A/D", KPI, { site_vocabulary_id: "gone" }), [ISO_FILE]), false);
  assert.equal(isKpiMetric(metric("m4", "A/E", KPI, { site_vocabulary_id: "v-iso" }), undefined), false);
  assert.equal(isKpiMetric(undefined, [ISO_FILE]), false);
});

Deno.test("a metric the seeded ISO 22400 names is still a KPI, linked or not", () => {
  assert.equal(isKpiMetric(metric("m1", "A/B", KPI, { standard: "ISO 22400" }), []), true);
});

function record(catalog: Record<string, unknown>[], siteVocabularies: SiteVocabularyRef[] | undefined): DeviceRecord {
  return {
    device: { id: "d1", sparkplug_id: "dev1", name: "Press 1" },
    config: [],
    links: [{ schema_id: "s1", submodel_key: null }],
    catalog,
    gateway: null,
    nameplate: null,
    templates: [],
    schemas: [{
      id: "s1",
      schema_name: "Press",
      semantic_id: null,
      schema_definition: { properties: Object.fromEntries(catalog.map((m) => [String(m.name), {}])) },
    }],
    definitions: [],
    siteVocabularies,
  };
}

const submodelIds = (rows: DeviceRecord) =>
  JSON.parse(JSON.stringify(buildEnvironment(rows).environment)).submodels.map((s: Anything) => s.idShort);

Deno.test("the export files a metric of an ISO 22400 file under KeyPerformanceIndicators and the rest under telemetry", () => {
  const catalog = [
    metric("m1", "Line/OEE", KPI, { site_vocabulary_id: "v-iso" }),
    metric("m2", "Line/Group", OTHER, { site_vocabulary_id: "v-own" }),
    metric("m3", "Line/Temperature", null),
  ];
  const built = buildEnvironment(record(catalog, [ISO_FILE, OWN_FILE]));
  const exported = JSON.parse(JSON.stringify(built.environment));
  const named = (idShort: string) => exported.submodels.find((s: Anything) => s.idShort === idShort);
  // The KPIs are the submodel's own elements; the telemetry is a collection of them.
  const kpis = named("KeyPerformanceIndicators").submodelElements.map((p: Anything) => p.idShort);
  const telemetry = named("OperationalTelemetry").submodelElements[0].value.map((p: Anything) => p.idShort);
  assert.equal(kpis, ["Line_OEE"]);
  assert.equal(telemetry, ["Line_Group", "Line_Temperature"]);
  assert.equal(built.stats.kpi_metrics, 1);
});

Deno.test("without the files the same metrics are telemetry, as they were", () => {
  const catalog = [metric("m1", "Line/OEE", KPI, { site_vocabulary_id: "v-iso" })];
  assert.equal(submodelIds(record(catalog, undefined)).includes("KeyPerformanceIndicators"), false);
});

Deno.test("the ConceptDescription of an exported KPI carries the licence rule through buildEnvironment", () => {
  const rows = record([metric("m1", "Line/OEE", KPI, { site_vocabulary_id: "v-iso" })], [ISO_FILE]);
  rows.siteConcepts = [concept(KPI, "Overall equipment effectiveness", LICENSED, ISO_FILE)];
  const exported = JSON.parse(JSON.stringify(buildEnvironment(rows).environment));
  const [cd] = exported.conceptDescriptions;
  const content = cd.embeddedDataSpecifications[0].dataSpecificationContent;
  assert.equal(content.preferredName[0].text, "Overall equipment effectiveness");
  assert.equal(content.definition[0].text, "Overall equipment effectiveness, as ISO 22400-2:2014 defines it.");
  assert.equal(JSON.stringify(exported).includes(LICENSED), false);
});

// ---- The loader --------------------------------------------------------------------------------

type Builder = Promise<{ data: Record<string, unknown>[] | null; error: unknown }> & {
  select: (columns?: string) => Builder;
  eq: () => Builder;
  in: (column: string, values: unknown[]) => Builder;
};

/** A client over fixed tables, which records what is read and from which ids, and in which one a read can fail. */
function client(tables: Record<string, object[]>, failing?: string) {
  const reads: { table: string; ids?: unknown[] }[] = [];
  const from = (table: string) => {
    const read: { table: string; ids?: unknown[] } = { table };
    reads.push(read);
    const result = table === failing
      ? { data: null, error: { message: `relation "${table}" does not exist` } }
      : { data: (tables[table] ?? []) as Record<string, unknown>[], error: null };
    const builder: Builder = Object.assign(Promise.resolve(result), {
      select: () => builder,
      eq: () => builder,
      in: (_: string, values: unknown[]) => {
        read.ids = values;
        return builder;
      },
    });
    return builder;
  };
  return { client: { from }, reads };
}

Deno.test("loadDeviceRecord reads the site concepts of the shell's ids and the files its metrics link to", async () => {
  const rows = record([metric("m1", "Line/OEE", KPI, { site_vocabulary_id: "v-iso" })], undefined);
  const { client: fake, reads } = client({
    devices: [rows.device],
    device_schemas: [{ device_id: "d1", schema_id: "s1", submodel_key: null }],
    metric_catalog: rows.catalog,
    schemas: rows.schemas,
    site_vocabulary_concepts: [concept(KPI, "OEE", LICENSED, ISO_FILE)],
    site_vocabularies: [ISO_FILE],
  });
  const loaded = await loadDeviceRecord(fake, "d1");
  assert.equal(reads.find((r) => r.table === "site_vocabulary_concepts")?.ids, [KPI]);
  assert.equal(reads.find((r) => r.table === "site_vocabularies")?.ids, ["v-iso"]);
  assert.equal(loaded?.siteConcepts?.length, 1);
  assert.equal(loaded?.siteVocabularies, [ISO_FILE]);
  assert.equal(
    JSON.parse(JSON.stringify(buildEnvironment(loaded as DeviceRecord).environment)).submodels
      .some((s: Anything) => s.idShort === "KeyPerformanceIndicators"),
    true,
  );
});

Deno.test("loadDeviceRecord reads no file when no metric links to one", async () => {
  const rows = record([metric("m1", "Line/OEE", KPI)], undefined);
  const { client: fake, reads } = client({
    devices: [rows.device],
    device_schemas: [{ device_id: "d1", schema_id: "s1", submodel_key: null }],
    metric_catalog: rows.catalog,
    schemas: rows.schemas,
  });
  const loaded = await loadDeviceRecord(fake, "d1");
  assert.equal(reads.some((r) => r.table === "site_vocabularies"), false);
  assert.equal(loaded?.siteVocabularies, []);
});

Deno.test("loadDeviceRecord still loads where the site tables cannot be read", async () => {
  const rows = record([metric("m1", "Line/OEE", KPI, { site_vocabulary_id: "v-iso" })], undefined);
  for (const failing of ["site_vocabulary_concepts", "site_vocabularies"]) {
    const { client: fake } = client({
      devices: [rows.device],
      device_schemas: [{ device_id: "d1", schema_id: "s1", submodel_key: null }],
      metric_catalog: rows.catalog,
      schemas: rows.schemas,
    }, failing);
    const loaded = await loadDeviceRecord(fake, "d1");
    assert.equal(loaded?.siteConcepts, []);
    assert.equal(loaded?.siteVocabularies, []);
  }
});
