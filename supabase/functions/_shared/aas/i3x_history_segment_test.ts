import type { DeviceRecord } from "./shell.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

// deno-lint-ignore no-explicit-any
type Anything = any;

// The module reads its endpoints when it loads, and each test module loads its own copy. Put back
// at once, because the environment is the process's and other test modules expect it unset.
const ENDPOINT = "https://i3x.plant.example/v1/objects/history";
const before = Deno.env.get("AAS_I3X_HISTORY_ENDPOINT");
Deno.env.set("AAS_I3X_HISTORY_ENDPOINT", ENDPOINT);
const { buildEnvironment, HISTORIAN_ENDPOINT } = await import("./shell.ts");
if (before === undefined) Deno.env.delete("AAS_I3X_HISTORY_ENDPOINT");
else Deno.env.set("AAS_I3X_HISTORY_ENDPOINT", before);

const SID = "dev0a1b2c3d4e5f60718293a";
const metric = (name: string, extra = {}) => ({ id: name, name, datatype: 10, semantic_id: null, ...extra });

const record = (schemas: Record<string, unknown>[]): DeviceRecord => ({
  device: { id: "d1", sparkplug_id: SID, name: "Press 1" },
  config: [],
  links: schemas.map((s) => ({ schema_id: String(s.id), submodel_key: null })),
  catalog: [
    metric("Spindle/SPEED"),
    metric("Spindle/LOAD"),
    metric("OEE", { standard: "ISO 22400" }),
    metric("Coolant/TEMPERATURE"),
  ],
  gateway: null,
  nameplate: null,
  templates: [],
  schemas,
  definitions: [],
});

const segmentsOf = (submodel: Anything) =>
  submodel.submodelElements.find((e: Anything) => e.idShort === "Segments").value;
const valueOf = (segment: Anything, idShort: string) =>
  segment.value.find((e: Anything) => e.idShort === idShort).value;

Deno.test("beside the PostgREST link, i3X's names the submodel's own metrics by their elementIds", () => {
  const { submodels } = buildEnvironment(record([{
    id: "s1",
    schema_name: "Mill",
    schema_definition: { properties: { "Spindle/SPEED": {}, "Spindle/LOAD": {}, "OEE": {} } },
  }]));
  const telemetry: Anything = submodels.find((s) => s.idShort === "OperationalTelemetry");
  const [postgrest, i3x] = segmentsOf(telemetry);
  // The PostgREST segment is as it was.
  assert.equal([postgrest.idShort, valueOf(postgrest, "Endpoint"), valueOf(postgrest, "Query")], [
    "LinkedSegment",
    HISTORIAN_ENDPOINT,
    `asset_id=eq.${SID}`,
  ]);
  assert.equal(i3x.idShort, "I3XLinkedSegment");
  assert.equal(i3x.value.map((e: Anything) => [e.idShort, e.valueType]), [
    ["Endpoint", "xs:anyURI"],
    ["Query", "xs:string"],
  ]);
  assert.equal(valueOf(i3x, "Endpoint"), ENDPOINT);
  // A KPI is in KeyPerformanceIndicators, so this submodel's query does not name it.
  assert.equal(JSON.parse(valueOf(i3x, "Query")), {
    elementIds: [`${SID}/Spindle/LOAD`, `${SID}/Spindle/SPEED`],
  });
});

Deno.test("each schema's segment names that submodel's metrics", () => {
  const { submodels } = buildEnvironment(record([
    { id: "s1", schema_name: "Mill", schema_definition: { properties: { "Spindle/SPEED": {} } } },
    { id: "s2", schema_name: "Coolant", schema_definition: { required: ["Coolant/TEMPERATURE"] } },
  ]));
  const queries = submodels
    .filter((s) => String(s.idShort).endsWith("_OperationalTelemetry"))
    .map((s) => [s.idShort, JSON.parse(valueOf(segmentsOf(s)[1], "Query")).elementIds]);
  assert.equal(queries, [
    ["Mill_OperationalTelemetry", [`${SID}/Spindle/SPEED`]],
    ["Coolant_OperationalTelemetry", [`${SID}/Coolant/TEMPERATURE`]],
  ]);
});
