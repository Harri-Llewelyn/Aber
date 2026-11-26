import { buildEnvironment, type DeviceRecord, globalAssetIdOf, i3xElementId, shellIdOf } from "./shell.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

// deno-lint-ignore no-explicit-any
type Anything = any;

/** The contract i3x/address_space.py asserts too. */
const CONTRACT = JSON.parse(
  Deno.readTextFileSync(new URL("../../../../test-harness/fixtures/asset-identities.json", import.meta.url)),
);

Deno.test("every case of the identity contract names the shell and the i3X element as i3X does", () => {
  if (CONTRACT.cases.length < 4) throw new Error("the contract lost its cases");
  for (const c of CONTRACT.cases) {
    assert.equal(globalAssetIdOf(c.sparkplug_id, c.base_iri), c.expected.globalAssetId, c.name);
    assert.equal(shellIdOf(c.sparkplug_id, c.base_iri), c.expected.shellId, c.name);
    assert.equal(i3xElementId(c.sparkplug_id, c.metric ?? undefined), c.expected.elementId, c.name);
  }
});

const record = (sparkplugId: string): DeviceRecord => ({
  device: { id: "d1", sparkplug_id: sparkplugId, name: "Press 1" },
  config: [],
  links: [{ schema_id: "s1", submodel_key: null }],
  catalog: [{ id: "m1", name: "PART_COUNT", datatype: 4, semantic_id: null }],
  gateway: null,
  nameplate: null,
  templates: [],
  schemas: [{ id: "s1", schema_name: "Press", schema_definition: { properties: { PART_COUNT: {} } } }],
  definitions: [],
});

Deno.test("a shell is named by the same rule, under the site's base", () => {
  const [c] = CONTRACT.cases;
  const { shell } = buildEnvironment(record(c.sparkplug_id));
  // The module's base is AAS_BASE_IRI, which these tests leave unset: the contract's first case's.
  assert.equal(c.base_iri, "https://aber.local/ids/asset/");
  assert.equal(shell.id, c.expected.shellId);
  assert.equal((shell.assetInformation as Anything).globalAssetId, c.expected.globalAssetId);
});

Deno.test("with no i3X server published, a history link names PostgREST alone", () => {
  const { submodels } = buildEnvironment(record("dev0a1b2c3d4e5f60718293a"));
  const telemetry: Anything = submodels.find((s) => s.idShort === "OperationalTelemetry");
  const segments = telemetry.submodelElements.find((e: Anything) => e.idShort === "Segments");
  assert.equal(segments.value.map((s: Anything) => s.idShort), ["LinkedSegment"]);
});
