/**
 * A schema version built from a submodel template (0342) exports each metric that fills an element with the
 * element's id as its semanticId and the metric's own id among its supplementalSemanticIds; the same metric in
 * a schema built any other way exports as it did. The rule is _shared/schemaTemplate.ts, held there.
 */
import { buildEnvironment, conceptIdsFor, type DeviceRecord } from "./shell.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

const NAMEPLATE = "https://admin-shell.io/idta/nameplate/3/0/Nameplate";
const MANUFACTURER = "0112/2///61987#ABA565#009";
const OWN = "https://example.org/concepts/manufacturer";

function record(): DeviceRecord {
  const definition = { properties: { "Plate/MANUFACTURER": {} } };
  return {
    device: { id: "d1", sparkplug_id: "dev1", name: "Press 1" },
    config: [],
    links: [{ schema_id: "built", submodel_key: null }, { schema_id: "typed", submodel_key: null }],
    catalog: [{ id: "m1", name: "Plate/MANUFACTURER", semantic_id: OWN, datatype: 12, description: "Who made it" }],
    gateway: null,
    nameplate: null,
    templates: [],
    schemas: [
      {
        id: "built", schema_name: "Plate", semantic_id: NAMEPLATE, schema_definition: definition,
        template_id: NAMEPLATE,
        template_elements: { "Plate/MANUFACTURER": { path: "ManufacturerName", semantic_id: MANUFACTURER } },
      },
      { id: "typed", schema_name: "Typed", semantic_id: null, schema_definition: definition, template_id: null, template_elements: null },
    ],
    supplemental: [],
    definitions: [],
  };
}

const propertyIn = (submodels: Record<string, unknown>[], idShort: string) => {
  const submodel = submodels.find((s) => s.idShort === idShort) as { submodelElements: { value: unknown[] }[] };
  return submodel.submodelElements[0].value[0] as Record<string, unknown>;
};
const ids = (reference: unknown) => (reference as { keys: { value: string }[] }).keys.map((k) => k.value);

Deno.test("a metric filling an element exports the element's id, with its own id beside it", () => {
  const { submodels } = buildEnvironment(record());
  const built = propertyIn(submodels, "Plate_OperationalTelemetry");
  assert.equal(ids(built.semanticId), [MANUFACTURER]);
  assert.equal((built.supplementalSemanticIds as unknown[]).map(ids), [[OWN]]);
});

Deno.test("the same metric in a schema built any other way exports as it did", () => {
  const { submodels } = buildEnvironment(record());
  const typed = propertyIn(submodels, "Typed_OperationalTelemetry");
  assert.equal(ids(typed.semanticId), [OWN]);
  assert.equal(typed.supplementalSemanticIds, undefined);
});

Deno.test("the loader reads a definition for the element's id", () => {
  assert.equal(conceptIdsFor(record()).includes(MANUFACTURER), true);
});
