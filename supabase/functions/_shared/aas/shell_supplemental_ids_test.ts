import {
  buildEnvironment,
  conceptIdsFor,
  type DeviceRecord,
  loadDeviceRecord,
  OPC_MACHINERY,
  property,
  referencedSemanticIds,
  supplementalIdsByMetric,
  supplementalReferences,
} from "./shell.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

const OWN = "https://example.org/concepts/temperature";
const ECLASS = "0112/2///61987#ABA951#009";
const NODE = "nsu=http://opcfoundation.org/UA/;i=2255";
const TEMPLATE = "https://admin-shell.io/idta/nameplate/3/0/Nameplate/SerialNumber";
const SERIAL_ID = "https://example.org/concepts/serial";

const metric = (id: string, name: string, semanticId: string | null, extra = {}) => ({
  id,
  name,
  semantic_id: semanticId,
  datatype: 10,
  units: "CELSIUS",
  description: `${name} description`,
  standard: null,
  deprecated: false,
  ...extra,
});

/** One device's rows, with the further ids a test names. */
function record(supplemental: DeviceRecord["supplemental"]): DeviceRecord {
  return {
    device: { id: "d1", sparkplug_id: "dev1", name: "AHU 1" },
    config: [],
    links: [{ schema_id: "s1", submodel_key: null }],
    catalog: [
      metric("m1", "Zone/TEMPERATURE", OWN),
      metric("m2", "Zone/LOCAL_EXTENSION", null),
      metric("m3", "Zone/UNMODELLED", "https://example.org/concepts/other"),
    ],
    gateway: null,
    nameplate: null,
    templates: [],
    schemas: [{
      id: "s1",
      schema_name: "Zone",
      semantic_id: null,
      schema_definition: { properties: { "Zone/TEMPERATURE": {}, "Zone/LOCAL_EXTENSION": {} } },
    }],
    supplemental,
    definitions: [],
  };
}

// deno-lint-ignore no-explicit-any
type Anything = any;

/** The Metrics collection of the exported schema's telemetry submodel, as it serialises. */
function properties(rows: DeviceRecord): Anything[] {
  const exported = JSON.parse(JSON.stringify(buildEnvironment(rows).environment));
  const telemetry = exported.submodels.find((s: Anything) => s.idShort === "OperationalTelemetry");
  return telemetry.submodelElements[0].value;
}

const named = (props: Anything[], idShort: string) => props.find((p) => p.idShort === idShort);

const reference = (id: string) => ({
  type: "ExternalReference",
  keys: [{ type: "GlobalReference", value: id }],
});

Deno.test("a metric's further ids are the supplementalSemanticIds of its Property, whatever their type", () => {
  const props = properties(record([
    { metric_id: "m1", semantic_id: NODE, semantic_id_type: "ExpandedNodeId" },
    { metric_id: "m1", semantic_id: ECLASS, semantic_id_type: "IRDI" },
    { metric_id: "m1", semantic_id: "https://example.org/concepts/also", semantic_id_type: "IRI" },
  ]));
  const element = named(props, "Zone_TEMPERATURE");
  assert.equal(element.semanticId, reference(OWN));
  // Sorted, so two exports of one device are the same bytes.
  assert.equal(element.supplementalSemanticIds, [
    reference(ECLASS),
    reference("https://example.org/concepts/also"),
    reference(NODE),
  ]);
});

Deno.test("a metric with no further id exports no key, as before", () => {
  const element = named(properties(record([])), "Zone_TEMPERATURE");
  assert.equal(Object.keys(element).includes("supplementalSemanticIds"), false);
  assert.equal(
    named(properties(record(undefined)), "Zone_TEMPERATURE").supplementalSemanticIds,
    undefined,
  );
});

Deno.test("a further id equal to the metric's own, or repeated, is exported once or not at all", () => {
  const element = named(
    properties(record([
      { metric_id: "m1", semantic_id: OWN },
      { metric_id: "m1", semantic_id: ECLASS },
      { metric_id: "m1", semantic_id: ECLASS },
    ])),
    "Zone_TEMPERATURE",
  );
  assert.equal(element.supplementalSemanticIds, [reference(ECLASS)]);
});

Deno.test("a metric with no id of its own exports none beside it (AASd-118)", () => {
  const element = named(
    properties(record([{ metric_id: "m2", semantic_id: ECLASS }])),
    "Zone_LOCAL_EXTENSION",
  );
  assert.equal(element.semanticId, undefined);
  assert.equal(element.supplementalSemanticIds, undefined);
  assert.equal(
    property("X", "xs:double", 1, { supplementalSemanticIds: [ECLASS] }).supplementalSemanticIds,
    undefined,
  );
});

Deno.test("a further id of a metric the device does not model is not exported", () => {
  const rows = record([{ metric_id: "m3", semantic_id: ECLASS }]);
  assert.equal(referencedSemanticIds(buildEnvironment(rows).submodels).includes(ECLASS), false);
  assert.equal(conceptIdsFor(rows).includes(ECLASS), false);
});

Deno.test("a ConceptDescription is written for each further id", () => {
  const rows = record([
    { metric_id: "m1", semantic_id: ECLASS },
    { metric_id: "m1", semantic_id: NODE },
  ]);
  const built = buildEnvironment(rows);
  assert.equal(
    referencedSemanticIds(built.submodels),
    [ECLASS, OWN, NODE].sort(),
  );
  const concepts = built.environment.conceptDescriptions as Anything[];
  assert.equal(concepts.map((c) => c.id), [ECLASS, OWN, NODE].sort());
  assert.equal(built.stats.concept_descriptions, 3);
  // Without a vocabulary row, an id nothing carries is defined as an unknown id is.
  const content = concepts.find((c) => c.id === ECLASS).embeddedDataSpecifications[0]
    .dataSpecificationContent;
  assert.equal(content.definition[0].text, "The concept Concept, which this shell references.");
});

Deno.test("a vocabulary defines a further id when it holds it", () => {
  const rows = record([{ metric_id: "m1", semantic_id: ECLASS }]);
  rows.definitions = [{
    semantic_id: ECLASS,
    name: "Temperature",
    definition: "The temperature, as ECLASS defines it.",
    standard: "ECLASS",
  }];
  const concepts = buildEnvironment(rows).environment.conceptDescriptions as Anything[];
  const content = concepts.find((c) => c.id === ECLASS).embeddedDataSpecifications[0]
    .dataSpecificationContent;
  assert.equal(content.definition, [{ language: "en", text: "The temperature, as ECLASS defines it." }]);
  assert.equal(content.preferredName, [{ language: "en", text: "Temperature" }]);
});

Deno.test("conceptIdsFor names the further ids of the metrics the schemas model", () => {
  const rows = record([
    { metric_id: "m1", semantic_id: NODE },
    { metric_id: "m1", semantic_id: ECLASS },
  ]);
  assert.equal(conceptIdsFor(rows), [ECLASS, OWN, NODE].sort());
  // The loader reads concept_definitions for exactly what the shell references.
  const referenced = referencedSemanticIds(buildEnvironment(rows).submodels);
  assert.equal(conceptIdsFor(rows), referenced);
});

Deno.test("supplementalIdsByMetric lists each metric's ids sorted and once, and reads no rows as none", () => {
  const byMetric = supplementalIdsByMetric([
    { metric_id: "m1", semantic_id: "b" },
    { metric_id: "m1", semantic_id: "a" },
    { metric_id: "m1", semantic_id: "b" },
    { metric_id: "m2", semantic_id: "c" },
  ]);
  assert.equal([...byMetric], [["m1", ["a", "b"]], ["m2", ["c"]]]);
  assert.equal([...supplementalIdsByMetric(undefined)], []);
  assert.equal(supplementalReferences(["a", "b", "a"], "b"), [reference("a")]);
  assert.equal(supplementalReferences([], null), undefined);
});

/** A nameplate whose Machinery serial number a device publishes under a metric. */
function nameplateRecord(supplemental: DeviceRecord["supplemental"], carrier = "m5") {
  const rows = record(supplemental);
  rows.config = [{ metric_name: "Machine/Serial", val_string: "SN-PUBLISHED" }];
  // The carrier of the further id comes before the metric that has the id as its own, which a device
  // published nothing under.
  rows.catalog = [
    ...rows.catalog,
    metric("m5", "Machine/Serial", SERIAL_ID, { datatype: 12, units: null }),
    metric("m6", "Machine/NoOwnId", null, { datatype: 12, units: null }),
    metric("m4", "Machine/Idle", OPC_MACHINERY.SerialNumber, { datatype: 12, units: null }),
  ];
  rows.templates = [{ id_short: "SerialNumber", semantic_id: TEMPLATE, description: "Serial" }];
  rows.supplemental = [...(supplemental ?? []), { metric_id: carrier, semantic_id: OPC_MACHINERY.SerialNumber }];
  return rows;
}

const serial = (rows: DeviceRecord) => {
  const exported = buildEnvironment(rows).submodels.find((s) => s.idShort === "DigitalNameplate");
  // deno-lint-ignore no-explicit-any
  return (exported?.submodelElements as Anything[]).find((e) => e.idShort === "SerialNumber");
};

Deno.test("the nameplate join finds a metric by a further id", () => {
  const rows = nameplateRecord([]);
  rows.catalog = rows.catalog.filter((m) => m.id !== "m4");
  assert.equal(serial(rows).value, "SN-PUBLISHED");
  assert.equal(serial(rows).description[0].text, "Published by the device at DBIRTH.");
});

Deno.test("a metric carrying the concept as its own id answers before one carrying it as a further id", () => {
  // m4 carries the Machinery id as its own and the device publishes nothing under it, so the field
  // is the operator's, not m5's, which carries it as a further id.
  const rows = nameplateRecord([]);
  rows.nameplate = { serial_number: "SN-OPERATOR" };
  assert.equal(serial(rows).value, "SN-OPERATOR");
  assert.equal(serial(rows).description[0].text, "Recorded against the asset by an operator.");
});

Deno.test("a metric with no id of its own joins on no further id", () => {
  const rows = nameplateRecord([], "m6");
  rows.catalog = rows.catalog.filter((m) => m.id !== "m4");
  rows.nameplate = { serial_number: "SN-OPERATOR" };
  assert.equal(serial(rows).value, "SN-OPERATOR");
});

type Builder = Promise<{ data: Record<string, unknown>[] | null; error: unknown }> & {
  select: () => Builder;
  eq: () => Builder;
  in: () => Builder;
};

/** A client over fixed tables, in which one table's read can fail. */
function client(tables: Record<string, object[]>, failing?: string) {
  const reads: string[] = [];
  const from = (table: string) => {
    reads.push(table);
    const result = table === failing
      ? { data: null, error: { message: `relation "${table}" does not exist` } }
      : { data: (tables[table] ?? []) as Record<string, unknown>[], error: null };
    const builder: Builder = Object.assign(Promise.resolve(result), {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
    });
    return builder;
  };
  return { client: { from }, reads };
}

Deno.test("loadDeviceRecord reads the further ids once and carries them", async () => {
  const rows = record([]);
  const { client: fake, reads } = client({
    devices: [rows.device],
    device_schemas: [{ device_id: "d1", schema_id: "s1", submodel_key: null }],
    metric_catalog: rows.catalog,
    schemas: rows.schemas,
    metric_semantic_ids: [{ metric_id: "m1", semantic_id: ECLASS, semantic_id_type: "IRDI" }],
  });
  const loaded = await loadDeviceRecord(fake, "d1");
  assert.equal(reads.filter((t) => t === "metric_semantic_ids").length, 1);
  assert.equal(loaded?.supplemental, [{ metric_id: "m1", semantic_id: ECLASS, semantic_id_type: "IRDI" }]);
  assert.equal(conceptIdsFor(loaded as DeviceRecord).includes(ECLASS), true);
});

Deno.test("loadDeviceRecord still loads where the further ids cannot be read", async () => {
  const rows = record([]);
  const { client: fake } = client({
    devices: [rows.device],
    device_schemas: [{ device_id: "d1", schema_id: "s1", submodel_key: null }],
    metric_catalog: rows.catalog,
    schemas: rows.schemas,
  }, "metric_semantic_ids");
  const loaded = await loadDeviceRecord(fake, "d1");
  assert.equal(loaded?.supplemental, []);
  assert.equal(
    named(properties(loaded as DeviceRecord), "Zone_TEMPERATURE").supplementalSemanticIds,
    undefined,
  );
});
