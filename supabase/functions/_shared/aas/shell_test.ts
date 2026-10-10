import {
  buildConceptDescriptions,
  buildEnvironment,
  conceptIdsFor,
  type DeviceRecord,
  loadDeviceRecord,
  OPC_MACHINERY,
  referencedSemanticIds,
} from "./shell.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

const S223 = "http://data.ashrae.org/standard223#";
const TEMPERATURE_SENSOR = "A `Sensor` that `observes` a `QuantifiableObservableProperty` that " +
  "represents a measure of temperature.";
const OPERATOR_CONCEPT = "urn:example:plant:safety-interlock";
const MANUFACTURER_NAME = "0112/2///61987#ABA565#009";

const metric = (name: string, semanticId: string | null, description: string, extra = {}) => ({
  name,
  semantic_id: semanticId,
  datatype: 10,
  units: "CELSIUS",
  description,
  standard: "ASHRAE 223P",
  deprecated: false,
  ...extra,
});

/** One device's rows, as loadDeviceRecord() returns them. */
function record(definitions: DeviceRecord["definitions"]): DeviceRecord {
  return {
    device: { id: "d1", sparkplug_id: "dev1", name: "AHU 1", status: "ONLINE" },
    config: [],
    links: [{ schema_id: "s1", submodel_key: null }],
    catalog: [
      metric("BMS/ZONE_TEMPERATURE", `${S223}TemperatureSensor`, "Zone air temperature"),
      metric("safety_interlock", OPERATOR_CONCEPT, "Safety interlock present", {
        datatype: 11,
        units: null,
        standard: null,
      }),
      metric("Unrelated/METRIC", `${S223}HumiditySensor`, "Not modelled by this device's schema"),
    ],
    gateway: null,
    nameplate: { manufacturer_name: "Acme" },
    templates: [{
      id_short: "ManufacturerName",
      semantic_id: MANUFACTURER_NAME,
      description: "Legal name of the manufacturer.",
    }],
    schemas: [{
      id: "s1",
      schema_name: "AHU",
      semantic_id: "https://example.org/submodels/AHU/1/0",
      schema_definition: { properties: { "BMS/ZONE_TEMPERATURE": {}, "safety_interlock": {} } },
    }],
    definitions,
  };
}

const DEFINED: DeviceRecord["definitions"] = [
  {
    semantic_id: `${S223}TemperatureSensor`,
    name: "TemperatureSensor",
    definition: TEMPERATURE_SENSOR,
    standard: "ASHRAE 223P",
  },
  // concept_definitions carries the nameplate concepts too, with the template's own text.
  {
    semantic_id: MANUFACTURER_NAME,
    name: "ManufacturerName",
    definition: "Legal name of the manufacturer.",
    standard: "IDTA",
  },
];

// deno-lint-ignore no-explicit-any
type Concept = any;

function contentOf(concepts: Concept[], id: string) {
  const concept = concepts.find((c) => c.id === id);
  if (!concept) throw new Error(`no ConceptDescription for ${id}`);
  return concept.embeddedDataSpecifications[0].dataSpecificationContent;
}

function concepts(rows: DeviceRecord): Concept[] {
  return buildEnvironment(rows).environment.conceptDescriptions as Concept[];
}

Deno.test("a vocabulary defines its concept, not the one metric that carries it", () => {
  const content = contentOf(concepts(record(DEFINED)), `${S223}TemperatureSensor`);
  assert.equal(content.definition, [{ language: "en", text: TEMPERATURE_SENSOR }]);
  assert.equal(content.preferredName, [{ language: "en", text: "TemperatureSensor" }]);
  // The unit and datatype still come from the catalog.
  assert.equal([content.unit, content.dataType], ["CELSIUS", "REAL_MEASURE"]);
});

Deno.test("catalog text defines only an id no vocabulary holds", () => {
  const defined = concepts(record(DEFINED));
  assert.equal(
    contentOf(defined, OPERATOR_CONCEPT).definition[0].text,
    "Safety interlock present",
  );
  // Without the vocabulary's row, the metric's description is all there is.
  assert.equal(
    contentOf(concepts(record([])), `${S223}TemperatureSensor`).definition[0].text,
    "Zone air temperature",
  );
});

Deno.test("a nameplate concept is unchanged by its row in concept_definitions", () => {
  const ids = [MANUFACTURER_NAME];
  const withRow = buildConceptDescriptions(ids, record(DEFINED));
  const without = buildConceptDescriptions(ids, record([]));
  assert.equal(withRow, without);
  const content = contentOf(withRow, MANUFACTURER_NAME);
  assert.equal(content.definition[0].text, "Legal name of the manufacturer.");
  assert.equal(content.dataType, "STRING");
});

Deno.test("conceptIdsFor names every id the shell references besides the nameplate's", () => {
  const rows = record(DEFINED);
  const referenced = referencedSemanticIds(buildEnvironment(rows).submodels)
    .filter((id) => !rows.templates.some((t) => t.semantic_id === id));
  assert.equal(conceptIdsFor(rows), referenced);
  assert.equal(referenced, [
    "http://data.ashrae.org/standard223#TemperatureSensor",
    "https://example.org/submodels/AHU/1/0",
    OPERATOR_CONCEPT,
  ]);
});

type Builder = Promise<{ data: Record<string, unknown>[]; error: null }> & {
  select: () => Builder;
  eq: (column: string, value: unknown) => Builder;
  in: (column: string, values: unknown[]) => Builder;
};

/** A supabase-js client over fixed tables, recording each query's table and filters. */
function fakeClient(tables: Record<string, object[]>) {
  const queries: { table: string; filters: [string, unknown][] }[] = [];
  const query = (table: string) => {
    const filters: [string, unknown][] = [];
    queries.push({ table, filters });
    const rows = () =>
      (tables[table] ?? []).map((row) => row as Record<string, unknown>).filter((row) =>
        filters.every(([column, value]) =>
          Array.isArray(value) ? value.includes(row[column]) : row[column] === value
        )
      );
    // Awaitable like supabase-js's builder. The filters are added synchronously, before the
    // promise's callback runs.
    const builder: Builder = Object.assign(
      Promise.resolve().then(() => ({ data: rows(), error: null })),
      {
        select: () => builder,
        eq: (column: string, value: unknown) => (filters.push([column, value]), builder),
        in: (column: string, values: unknown[]) => (filters.push([column, values]), builder),
      },
    );
    return builder;
  };
  return { client: { from: query }, queries };
}

Deno.test("loadDeviceRecord reads concept_definitions once, for the ids the shell can use", async () => {
  const rows = record(DEFINED);
  const { client, queries } = fakeClient({
    devices: [rows.device],
    device_schemas: [{ device_id: "d1", schema_id: "s1", submodel_key: null }],
    metric_catalog: rows.catalog,
    idta_submodel_templates: rows.templates,
    schemas: rows.schemas,
    concept_definitions: [
      ...DEFINED,
      {
        semantic_id: `${S223}HumiditySensor`,
        name: "HumiditySensor",
        definition: "A `Sensor` that observes humidity.",
        standard: "ASHRAE 223P",
      },
    ],
  });
  const loaded = await loadDeviceRecord(client, "d1");
  const reads = queries.filter((q) => q.table === "concept_definitions");
  assert.equal(reads.length, 1);
  assert.equal(reads[0].filters, [["semantic_id", conceptIdsFor(rows)]]);
  assert.equal(loaded?.definitions.map((d) => d.semantic_id), [`${S223}TemperatureSensor`]);
});

Deno.test("a metric carrying a Machinery ExpandedNodeId answers its nameplate field", () => {
  const rows = record(DEFINED);
  rows.config = [
    { metric_name: "Machine/Manufacturer", val_string: "Published GmbH" },
    { metric_name: "Machine/SerialNumber", val_string: "SN-PUBLISHED" },
  ];
  rows.catalog = [
    ...rows.catalog,
    metric("Machine/Manufacturer", OPC_MACHINERY.Manufacturer, "Manufacturer", { datatype: 12, units: null }),
    // The former IRI joins nothing, so the operator's value stands.
    metric("Machine/SerialNumber", "http://opcfoundation.org/UA/Machinery/SerialNumber", "Serial", {
      datatype: 12,
      units: null,
    }),
  ];
  rows.nameplate = { manufacturer_name: "Acme", serial_number: "SN-STORED" };
  // deno-lint-ignore no-explicit-any
  const nameplate = (buildEnvironment(rows).submodels as any[])
    .find((s) => s.idShort === "DigitalNameplate").submodelElements;
  // deno-lint-ignore no-explicit-any
  const field = (idShort: string) => nameplate.find((e: any) => e.idShort === idShort);
  assert.equal(
    [field("ManufacturerName").value, field("ManufacturerName").description[0].text],
    ["Published GmbH", "Published by the device at DBIRTH."],
  );
  assert.equal(field("SerialNumber").value, "SN-STORED");
});

Deno.test("the nameplate's OPC UA ids are Machinery ExpandedNodeIds", () => {
  for (const id of Object.values(OPC_MACHINERY)) {
    if (!/^nsu=http:\/\/opcfoundation\.org\/UA\/Machinery\/;i=\d+$/.test(id)) {
      throw new Error(`${id} is not a Machinery ExpandedNodeId`);
    }
  }
});
