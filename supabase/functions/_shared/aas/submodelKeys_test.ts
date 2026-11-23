import { assignSubmodelKeys, shortRootId } from "./submodelKeys.ts";
import { buildEnvironment, type DeviceRecord } from "./shell.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

const ROOT_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROOT_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PREFIX = "https://aber.local/ids/asset/dev1/submodel";

const catalog = [
  { name: "Temp", semantic_id: null, datatype: 10, standard: null, deprecated: false },
  { name: "OEE", semantic_id: null, datatype: 10, standard: "ISO 22400", deprecated: false },
];

/** One `schemas` row, as the database returns it since 0298. */
function schema(
  id: string,
  name: string,
  version: number,
  status: string,
  lineage: { root: string; name: string },
) {
  return {
    id,
    schema_name: name,
    version,
    status,
    lineage_root_id: lineage.root,
    lineage_name: lineage.name,
    schema_definition: { properties: { Temp: {}, OEE: {} } },
  };
}

function record(
  schemas: Record<string, unknown>[],
  links: { schema_id: string; submodel_key: string | null }[] = schemas.map((s) => ({
    schema_id: String(s.id),
    submodel_key: null,
  })),
): DeviceRecord {
  return {
    device: { id: "d1", sparkplug_id: "dev1", name: "Arm 1" },
    config: [],
    links,
    catalog,
    gateway: null,
    nameplate: null,
    templates: [],
    schemas,
    definitions: [],
  };
}

const idsOf = (rows: DeviceRecord) =>
  buildEnvironment(rows).submodels.map((s) => String(s.id).replace(`${PREFIX}/`, ""));

const ARM = { root: ROOT_A, name: "Robot_Arm_Schema" };

Deno.test("a Submodel's id keeps the lineage's name when a version is published", () => {
  // Version 1 and the same schema after a publish: the version's own name differs, the id does not.
  const first = record([schema("s1", "Robot_Arm_Schema", 1, "active", { root: ROOT_A, name: ARM.name })]);
  const second = record([schema("s2", "Robot_Arm_Schema_v2", 2, "active", ARM)]);
  assert.equal(idsOf(first), idsOf(second));
  assert.equal(idsOf(second).filter((id) => id.startsWith("Robot_Arm_Schema/")), [
    "Robot_Arm_Schema/OperationalTelemetry",
    "Robot_Arm_Schema/KeyPerformanceIndicators",
  ]);
});

Deno.test("a version that names its own lineage is untouched: a schema never versioned keeps its id", () => {
  const rows = record([{
    id: "s1",
    schema_name: "Robot-Arm",
    schema_definition: { properties: { Temp: {} } },
  }]);
  // A row from before 0298 carries no lineage columns: it is its own lineage, named as it was.
  assert.equal(idsOf(rows).filter((id) => id.includes("Robot")), ["Robot_Arm/OperationalTelemetry"]);
});

Deno.test("each schema-derived Submodel carries the version that produced it", () => {
  const built = buildEnvironment(
    record([schema("s3", "Robot_Arm_Schema_v3", 3, "active", ARM)]),
  );
  const derived = built.submodels.filter((s) => String(s.id).includes("/Robot_Arm_Schema/"));
  assert.equal(derived.length, 2);
  for (const submodel of derived) assert.equal(submodel.administration, { version: "3" });
  // The nameplate is not derived from a schema.
  const nameplate = built.submodels.find((s) => String(s.id).endsWith("/Nameplate"));
  assert.equal(nameplate?.administration, undefined);
});

Deno.test("the version moves while the id stays across a publish", () => {
  const before = buildEnvironment(record([schema("s1", ARM.name, 1, "active", ARM)])).submodels;
  const after = buildEnvironment(record([schema("s2", "Robot_Arm_Schema_v2", 2, "active", ARM)]))
    .submodels;
  const pick = (all: Record<string, unknown>[]) =>
    all.find((s) => String(s.id).endsWith("/OperationalTelemetry")) as Record<string, unknown>;
  assert.equal(pick(before).id, pick(after).id);
  assert.equal([pick(before).administration, pick(after).administration], [
    { version: "1" },
    { version: "2" },
  ]);
});

Deno.test("a draft attached beside its version in force takes a version-qualified key", () => {
  const rows = record([
    schema("s1", ARM.name, 1, "active", ARM),
    schema("s2", "Robot_Arm_Schema_v2", 2, "draft", ARM),
  ]);
  const built = buildEnvironment(rows);
  const ids = idsOf(rows).filter((id) => id.startsWith("Robot_Arm_Schema"));
  assert.equal(ids.sort(), [
    "Robot_Arm_Schema/KeyPerformanceIndicators",
    "Robot_Arm_Schema/OperationalTelemetry",
    "Robot_Arm_Schema_v2/KeyPerformanceIndicators",
    "Robot_Arm_Schema_v2/OperationalTelemetry",
  ]);
  assert.equal(built.stats.submodel_key_clashes, 0);
  // More than one schema: the idShort is qualified by the key, so the two differ as well.
  const shorts = built.submodels.map((s) => s.idShort).filter((s) => String(s).startsWith("Robot"));
  assert.equal(new Set(shorts).size, 4);
  // The version in force keeps the plain key, and the draft's key carries its version.
  const versionOf = (key: string) =>
    built.submodels.find((s) => s.id === `${PREFIX}/${key}/OperationalTelemetry`)?.administration;
  assert.equal(
    [versionOf("Robot_Arm_Schema"), versionOf("Robot_Arm_Schema_v2")],
    [{ version: "1" }, { version: "2" }],
  );
});

Deno.test("a draft alone keeps the lineage's key, so publishing it moves nothing", () => {
  const draft = record([schema("s2", "Robot_Arm_Schema_v2", 2, "draft", ARM)]);
  assert.equal(idsOf(draft).filter((id) => id.includes("Robot")), [
    "Robot_Arm_Schema/OperationalTelemetry",
    "Robot_Arm_Schema/KeyPerformanceIndicators",
  ]);
});

Deno.test("two lineages that map to one key stay apart, and the export counts it", () => {
  const rows = record([
    schema("sa", "Robot-Arm", 1, "active", { root: ROOT_A, name: "Robot-Arm" }),
    schema("sb", "Robot_Arm", 1, "active", { root: ROOT_B, name: "Robot_Arm" }),
  ]);
  const built = buildEnvironment(rows);
  const ids = idsOf(rows).filter((id) => id.includes("Robot_Arm"));
  assert.equal(ids.sort(), [
    "Robot_Arm/KeyPerformanceIndicators",
    "Robot_Arm/OperationalTelemetry",
    "Robot_Arm_22222222/KeyPerformanceIndicators",
    "Robot_Arm_22222222/OperationalTelemetry",
  ]);
  assert.equal(built.stats.submodel_key_clashes, 1);
  assert.equal(new Set(built.submodels.map((s) => s.id)).size, built.submodels.length);
});

Deno.test("which lineage keeps the plain key does not depend on the order the rows arrive in", () => {
  const a = schema("sa", "Robot-Arm", 1, "active", { root: ROOT_A, name: "Robot-Arm" });
  const b = schema("sb", "Robot_Arm", 1, "active", { root: ROOT_B, name: "Robot_Arm" });
  assert.equal(idsOf(record([a, b])).sort(), idsOf(record([b, a])).sort());
});

Deno.test("a key the operator declared is used as it stands, and wins the plain key", () => {
  const a = schema("sa", "Robot_Arm", 1, "active", { root: ROOT_A, name: "Robot_Arm" });
  const b = schema("sb", "Cell_Arm", 1, "active", { root: ROOT_B, name: "Cell_Arm" });
  const rows = record([a, b], [
    { schema_id: "sa", submodel_key: null },
    { schema_id: "sb", submodel_key: "Robot_Arm" },
  ]);
  const built = buildEnvironment(rows);
  const ids = idsOf(rows).filter((id) => id.endsWith("/OperationalTelemetry"));
  assert.equal(ids.sort(), ["Robot_Arm/OperationalTelemetry", "Robot_Arm_11111111/OperationalTelemetry"]);
  assert.equal(built.stats.submodel_key_clashes, 1);
  // The declared key goes with the attachment: it is the one that kept the plain key.
  assert.equal(
    built.submodels.find((s) => s.id === `${PREFIX}/Robot_Arm/OperationalTelemetry`)?.idShort,
    "Robot_Arm_OperationalTelemetry",
  );
});

Deno.test("assignSubmodelKeys qualifies with a short form of the root id and keeps every key unique", () => {
  const keyed = (id: string, rootId: string, rootKey: string, declaredKey: string | null = null) => ({
    id,
    rootId,
    rootKey,
    version: 1,
    status: "active",
    declaredKey,
  });
  const { keys, clashes } = assignSubmodelKeys([
    keyed("x", ROOT_A, "Arm"),
    keyed("y", ROOT_B, "Arm"),
    keyed("z", "33333333-cccc-4ccc-8ccc-cccccccccccc", "Arm_22222222"),
  ]);
  assert.equal([...keys.entries()].sort(), [
    ["x", "Arm"],
    ["y", "Arm_22222222"],
    ["z", "Arm_22222222_33333333"],
  ]);
  assert.equal(clashes, 2);
  assert.equal(shortRootId(ROOT_A), "11111111");

  // One lineage's three attachments that all declare one key: still three keys.
  const declared = assignSubmodelKeys([
    keyed("p", ROOT_A, "Arm", "Arm"),
    keyed("q", ROOT_A, "Arm", "Arm"),
    keyed("r", ROOT_A, "Arm", "Arm"),
  ]);
  assert.equal([...declared.keys.entries()], [
    ["p", "Arm"],
    ["q", "Arm_11111111"],
    ["r", "Arm_11111111_2"],
  ]);
  assert.equal(declared.clashes, 2);
});
