/**
 * The export rule for a version built from a submodel template (0342): the element's id is primary and the
 * metric's own id supplemental; any other version exports as it did.
 */
import { filledElementId, templateElementIds, templateSemanticIds } from "./schemaTemplate.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

const TEMPLATE = "https://admin-shell.io/idta/nameplate/3/0/Nameplate";
const MANUFACTURER = "0112/2///61987#ABA565#009";
const OWN = "https://example.com/aber/Nameplate/MANUFACTURER";
const FURTHER = "urn:aber:example:manufacturer";

const built = {
  template_id: TEMPLATE,
  template_elements: { "Nameplate/MANUFACTURER": { path: "ManufacturerName", semantic_id: MANUFACTURER } },
};

Deno.test("in a version built from a template, the element's id is primary and the metric's own id supplemental", () => {
  assert.equal(templateSemanticIds(built, "Nameplate/MANUFACTURER", OWN, [FURTHER]), {
    semanticId: MANUFACTURER,
    supplementalSemanticIds: [OWN, FURTHER].sort(),
  });
});

Deno.test("a further id that is the element's is not said twice", () => {
  assert.equal(templateSemanticIds(built, "Nameplate/MANUFACTURER", OWN, [MANUFACTURER]), {
    semanticId: MANUFACTURER,
    supplementalSemanticIds: [OWN],
  });
  assert.equal(templateSemanticIds(built, "Nameplate/MANUFACTURER", MANUFACTURER, []), {
    semanticId: MANUFACTURER,
    supplementalSemanticIds: undefined,
  });
});

Deno.test("a metric that fills no element, and a version built any other way, export as they did", () => {
  const before = { semanticId: OWN, supplementalSemanticIds: [FURTHER] };
  assert.equal(templateSemanticIds(built, "Spindle/LOAD", OWN, [FURTHER]), before);
  assert.equal(templateSemanticIds({ template_id: null, template_elements: null }, "Nameplate/MANUFACTURER", OWN, [FURTHER]), before);
  assert.equal(templateSemanticIds({}, "Nameplate/MANUFACTURER", OWN, [FURTHER]), before, "a database without the columns");
  assert.equal(templateSemanticIds(undefined, "Nameplate/MANUFACTURER", null, undefined), {
    semanticId: null,
    supplementalSemanticIds: undefined,
  });
});

Deno.test("elements without a template, or of another shape, are none", () => {
  assert.equal(filledElementId({ template_elements: built.template_elements }, "Nameplate/MANUFACTURER"), null);
  assert.equal(filledElementId({ template_id: TEMPLATE, template_elements: [] }, "Nameplate/MANUFACTURER"), null);
  assert.equal(filledElementId({ template_id: TEMPLATE, template_elements: { "Nameplate/MANUFACTURER": "ManufacturerName" } }, "Nameplate/MANUFACTURER"), null);
});

Deno.test("the ids a shell references include each element a version's metric fills, once", () => {
  const other = {
    template_id: TEMPLATE,
    template_elements: {
      "Nameplate/MANUFACTURER_TOO": { path: "ManufacturerName", semantic_id: MANUFACTURER },
      "Nameplate/URI": { path: "URIOfTheProduct", semantic_id: "0112/2///61987#ABN590#002" },
    },
  };
  assert.equal(templateElementIds([built, other, { template_id: null }]), ["0112/2///61987#ABA565#009", "0112/2///61987#ABN590#002"]);
});
