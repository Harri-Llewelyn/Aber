import { environmentToXml } from "./environmentXml.ts";
import {
  buildEnvironment,
  CONTACT_INFORMATION_TEMPLATE_ID,
  type DeviceRecord,
  loadDeviceRecord,
  MANDATORY_ADDRESS_ELEMENTS,
  mandatoryNameplatePaths,
  NAMEPLATE_TEMPLATE_ID,
  OPC_MACHINERY,
  type TemplateElement,
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

/** The rows `idta_template_elements` holds of a template, from the file they are generated from. */
function templateRows(file: string, name: string, number: string): TemplateElement[] {
  const environment = JSON.parse(
    Deno.readTextFileSync(new URL(`../../../../scripts/vocabularies/${file}`, import.meta.url)),
  );
  const [submodel] = environment.submodels;
  const templateId = submodel.semanticId.keys[0].value;
  const rows: TemplateElement[] = [];
  const visit = (element: Anything, parent: string | null, index: number, inList: boolean) => {
    const path = parent === null ? element.idShort : inList ? `${parent}[${index}]` : `${parent}.${element.idShort}`;
    rows.push({
      template_id: templateId,
      template_name: name,
      template_number: number,
      path,
      parent_path: parent,
      ordinal: rows.length + 1,
      id_short: element.idShort ?? null,
      model_type: element.modelType,
      value_type: element.modelType === "Property" ? element.valueType : null,
      semantic_id: element.semanticId?.keys?.[0]?.value ?? null,
      cardinality: (element.qualifiers ?? []).find((q: Anything) =>
        ["SMT/Cardinality", "Cardinality", "Multiplicity"].includes(q.type)
      )?.value ?? null,
    });
    const list = element.modelType === "SubmodelElementList";
    if (list || element.modelType === "SubmodelElementCollection") {
      (element.value ?? []).forEach((child: Anything, at: number) => visit(child, path, at, list));
    }
  };
  submodel.submodelElements.forEach((element: Anything, at: number) => visit(element, null, at, false));
  return rows;
}

const NAMEPLATE_ROWS = templateRows("idta-02006-3-0-3-digital-nameplate.json", "Digital Nameplate", "IDTA 02006");
const CONTACT_ROWS = templateRows(
  "idta-02002-1-0-4-contact-information.json",
  "Contact Information",
  "IDTA 02002",
);

/** Every column of a nameplate the template asks for, and no other. */
const MANDATORY_COLUMNS: Record<string, string> = {
  "URIOfTheProduct": "uri_of_the_product",
  "ManufacturerName": "manufacturer_name",
  "ManufacturerProductDesignation": "manufacturer_product_designation",
  "AddressInformation.Street": "address_street",
  "AddressInformation.Zipcode": "address_zipcode",
  "AddressInformation.CityTown": "address_city_town",
  "AddressInformation.NationalCode": "address_national_code",
  "OrderCodeOfManufacturer": "order_code_of_manufacturer",
};
const COMPLETE: Record<string, unknown> = {
  uri_of_the_product: "https://example.com/products/lathe/0042",
  manufacturer_name: "Acme & Sons",
  manufacturer_product_designation: "Lathe 42",
  address_street: "1 Example Road",
  address_zipcode: "SA1 8EN",
  address_city_town: "Swansea",
  address_national_code: "GB",
  order_code_of_manufacturer: "FMABC1234",
};

function record(nameplate: Record<string, unknown> | null, more: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    device: { id: "d1", sparkplug_id: "dev1", name: "Lathe 1 on the shopfloor" },
    config: [],
    links: [],
    catalog: [],
    gateway: { name: "Line A", sparkplug_id: "gwy1" },
    nameplate,
    templates: NAMEPLATE_ROWS.filter((e) => e.parent_path === null).map((e) => ({
      id_short: String(e.id_short),
      semantic_id: String(e.semantic_id),
      description: `${e.id_short}, as 0002 describes it.`,
    })),
    elements: [...NAMEPLATE_ROWS, ...CONTACT_ROWS],
    schemas: [],
    definitions: [],
    ...more,
  };
}

const submodelOf = (rows: DeviceRecord, idShort: string): Anything =>
  (JSON.parse(JSON.stringify(buildEnvironment(rows).submodels)) as Anything[]).find((s) => s.idShort === idShort);
const nameplateOf = (rows: DeviceRecord) => submodelOf(rows, "DigitalNameplate");
const element = (submodel: Anything, idShort: string) =>
  (submodel?.submodelElements ?? submodel?.value ?? []).find((e: Anything) => e.idShort === idShort);
const statsOf = (rows: DeviceRecord) => {
  const { claimed_templates, nameplate_missing_elements } = buildEnvironment(rows).stats;
  return [claimed_templates, nameplate_missing_elements];
};
const claim = (rows: DeviceRecord) => nameplateOf(rows)?.semanticId?.keys?.[0]?.value;

Deno.test("what a nameplate must hold is the template's own list, with the four address elements its specification names", () => {
  assert.equal(mandatoryNameplatePaths([...NAMEPLATE_ROWS, ...CONTACT_ROWS]), Object.keys(MANDATORY_COLUMNS));
  // In the template's order, however the rows arrive.
  assert.equal(mandatoryNameplatePaths([...NAMEPLATE_ROWS].reverse()), Object.keys(MANDATORY_COLUMNS));
  assert.equal([...MANDATORY_ADDRESS_ELEMENTS], ["Street", "Zipcode", "CityTown", "NationalCode"]);
  assert.equal([mandatoryNameplatePaths([]), mandatoryNameplatePaths(undefined)], [[], []]);
  // Contact Information marks each of the four optional, which is why they are written down.
  for (const name of MANDATORY_ADDRESS_ELEMENTS) {
    const row = CONTACT_ROWS.find((e) => e.path === `ContactInformation.${name}`);
    assert.equal([row?.template_id, row?.cardinality], [CONTACT_INFORMATION_TEMPLATE_ID, "ZeroToOne"], name);
  }
});

Deno.test("a nameplate with every mandatory element carries the template's id, and the stats count it", () => {
  const rows = record(COMPLETE);
  assert.equal(nameplateOf(rows).semanticId, {
    type: "ExternalReference",
    keys: [{ type: "GlobalReference", value: NAMEPLATE_TEMPLATE_ID }],
  });
  assert.equal(statsOf(rows), [1, 0]);
});

Deno.test("a nameplate that lacks any one of them carries no id, and the stats count what is missing", () => {
  for (const [path, column] of Object.entries(MANDATORY_COLUMNS)) {
    for (const value of [undefined, null, "", "   "]) {
      const rows = record({ ...COMPLETE, [column]: value });
      assert.equal("semanticId" in nameplateOf(rows), false, `${path} as ${JSON.stringify(value)}`);
      assert.equal(statsOf(rows), [0, 1], path);
    }
  }
  assert.equal(statsOf(record({ serial_number: "SN-1" })), [0, 8]);
});

Deno.test("an optional element is never what a claim waits for", () => {
  const optional = {
    address_state_county: "West Glamorgan",
    manufacturer_product_type: "FM-ABC-1234",
    serial_number: "SN-1",
    year_of_construction: "2022",
    date_of_manufacture: "2022-01-01",
    hardware_version: "1.0",
    firmware_version: "1.1",
    software_version: "1.2",
    country_of_origin: "DE",
  };
  assert.equal(claim(record({ ...COMPLETE, ...optional })), NAMEPLATE_TEMPLATE_ID);
  assert.equal(claim(record(COMPLETE)), NAMEPLATE_TEMPLATE_ID);
  assert.equal(claim(record(optional)), undefined);
});

Deno.test("a value the device publishes counts as its own", () => {
  const { manufacturer_name: _recorded, ...withoutName } = COMPLETE;
  const published = {
    catalog: [{
      name: "Machine/Manufacturer",
      semantic_id: OPC_MACHINERY.Manufacturer,
      datatype: 12,
      description: "Manufacturer",
      standard: null,
      deprecated: false,
    }],
    config: [{ metric_name: "Machine/Manufacturer", val_string: "Published GmbH" }],
  };
  assert.equal(claim(record(withoutName)), undefined);
  assert.equal(claim(record(withoutName, published)), NAMEPLATE_TEMPLATE_ID);
  assert.equal(element(nameplateOf(record(withoutName, published)), "ManufacturerName").value, [
    { language: "en", text: "Published GmbH" },
  ]);
});

Deno.test("the device's own name never stands in for the manufacturer's designation", () => {
  const { manufacturer_product_designation: _gone, ...rest } = COMPLETE;
  const nameplate = nameplateOf(record(rest));
  assert.equal(element(nameplate, "ManufacturerProductDesignation"), undefined);
  assert.equal(JSON.stringify(nameplate).includes("Lathe 1 on the shopfloor"), false);
});

Deno.test("without the template's rows nothing is claimed, and an element is a string as it was", () => {
  for (const elements of [undefined, []]) {
    const rows = record(COMPLETE, { elements });
    assert.equal(claim(rows), undefined);
    assert.equal(statsOf(rows), [0, 0]);
    const name = element(nameplateOf(rows), "ManufacturerName");
    assert.equal([name.modelType, name.valueType, name.value], ["Property", "xs:string", "Acme & Sons"]);
  }
});

Deno.test("each element is typed and identified as its template has it", () => {
  const nameplate = nameplateOf(record({
    ...COMPLETE,
    address_state_county: "West Glamorgan",
    manufacturer_product_type: "FM-ABC-1234",
    serial_number: "SN-1",
    year_of_construction: "2022",
    date_of_manufacture: "2022-01-01",
    hardware_version: "1.0",
    firmware_version: "1.1",
    software_version: "1.2",
    country_of_origin: "DE",
  }));
  const compare = (held: Anything, row: TemplateElement | undefined) => {
    assert.equal(
      [held.modelType, held.valueType ?? null, held.semanticId?.keys?.[0]?.value],
      [row?.model_type, row?.model_type === "Property" ? row?.value_type : null, row?.semantic_id],
      held.idShort,
    );
  };
  for (const held of nameplate.submodelElements) {
    compare(held, NAMEPLATE_ROWS.find((e) => e.path === held.idShort));
  }
  // In the template's order, so a viewer reads it as the specification does.
  const order = NAMEPLATE_ROWS.filter((e) => e.parent_path === null).map((e) => e.path);
  const ids = nameplate.submodelElements.map((e: Anything) => e.idShort);
  assert.equal(ids, order.filter((path) => ids.includes(path)));
  assert.equal(ids.length, 13);

  const address = element(nameplate, "AddressInformation");
  for (const held of address.value) {
    compare(held, CONTACT_ROWS.find((e) => e.path === `ContactInformation.${held.idShort}`));
  }
  assert.equal(
    address.value.map((e: Anything) => [e.idShort, e.value]),
    [["Street", "1 Example Road"], ["Zipcode", "SA1 8EN"], ["CityTown", "Swansea"], ["StateCounty", "West Glamorgan"], ["NationalCode", "GB"]]
      .map(([id, text]) => [id, [{ language: "en", text }]]),
  );
});

Deno.test("an address with one element is exported, and with none is left out", () => {
  assert.equal(
    element(nameplateOf(record({ manufacturer_name: "Acme", address_city_town: "Swansea" })), "AddressInformation").value
      .map((e: Anything) => e.idShort),
    ["CityTown"],
  );
  assert.equal(element(nameplateOf(record({ manufacturer_name: "Acme" })), "AddressInformation"), undefined);
});

Deno.test("a text longer than a multi-language property may hold is left out, not cut, and counts as missing", () => {
  const rows = record({ ...COMPLETE, manufacturer_name: "A".repeat(1024) });
  assert.equal(element(nameplateOf(rows), "ManufacturerName"), undefined);
  assert.equal(statsOf(rows), [0, 1]);
  assert.equal(claim(record({ ...COMPLETE, manufacturer_name: "A".repeat(1023) })), NAMEPLATE_TEMPLATE_ID);
});

Deno.test("a nameplate holds its template's elements alone, and the platform's are in PlatformConnection", () => {
  const rows = record(COMPLETE);
  const known = new Set(NAMEPLATE_ROWS.map((e) => e.path));
  assert.equal(nameplateOf(rows).submodelElements.filter((e: Anything) => !known.has(e.idShort)), []);

  const platform = submodelOf(rows, "PlatformConnection");
  assert.equal(platform.id.endsWith("dev1/submodel/PlatformConnection"), true);
  assert.equal(
    platform.submodelElements.map((e: Anything) => [e.idShort, e.value, "semanticId" in e]),
    [["AssetSparkplugId", "dev1", false], ["EdgeGatewayName", "Line A", false], ["EdgeGatewaySparkplugId", "gwy1", false]],
  );
  assert.equal("semanticId" in platform, false);
});

Deno.test("a device with no nameplate value has no nameplate submodel, and still its platform connection", () => {
  for (const nameplate of [null, { serial_number: "  " }]) {
    const rows = record(nameplate, { gateway: null });
    const built = buildEnvironment(rows);
    assert.equal((built.submodels as Anything[]).map((s) => s.idShort), ["PlatformConnection"]);
    const references = JSON.parse(JSON.stringify(built.shell.submodels)) as Anything[];
    assert.equal(references.map((r) => r.keys[0].value), [(built.submodels as Anything[])[0].id]);
    assert.equal(statsOf(rows), [0, 8]);
    // A device with no gateway names none, and an unset value is left out of its property.
    assert.equal(
      submodelOf(rows, "PlatformConnection").submodelElements.map((e: Anything) => [e.idShort, "value" in e]),
      [["AssetSparkplugId", true], ["EdgeGatewayName", false], ["EdgeGatewaySparkplugId", false]],
    );
  }
});

Deno.test("every id a complete nameplate carries has a ConceptDescription, with no dictionary's text", () => {
  const { environment } = buildEnvironment(record({ ...COMPLETE, date_of_manufacture: "2022-01-01" }));
  const concepts = new Map(
    (environment.conceptDescriptions as Anything[]).map((c) => [
      c.id,
      c.embeddedDataSpecifications[0].dataSpecificationContent,
    ]),
  );
  const of = (path: string, rows: TemplateElement[]) => concepts.get(rows.find((e) => e.path === path)?.semantic_id);
  assert.equal(of("ManufacturerName", NAMEPLATE_ROWS).dataType, "STRING_TRANSLATABLE");
  assert.equal(of("URIOfTheProduct", NAMEPLATE_ROWS).dataType, "IRI");
  assert.equal(of("DateOfManufacture", NAMEPLATE_ROWS).dataType, "DATE");
  assert.equal(of("OrderCodeOfManufacturer", NAMEPLATE_ROWS).dataType, "STRING");
  assert.equal(of("AddressInformation", NAMEPLATE_ROWS).dataType, undefined);
  const street = of("ContactInformation.Street", CONTACT_ROWS);
  assert.equal(
    [street.preferredName[0].text, street.definition[0].text, street.dataType],
    ["Street", "The IDTA 02002 Contact Information element Street.", "STRING_TRANSLATABLE"],
  );
  const template = concepts.get(NAMEPLATE_TEMPLATE_ID);
  assert.equal(template.preferredName[0].text, "Digital Nameplate");
  assert.equal(template.definition[0].text.startsWith("The submodel template IDTA 02006, Digital Nameplate."), true);
  // An incomplete one claims no template, so it describes none.
  const incomplete = buildEnvironment(record({ manufacturer_name: "Acme" })).environment.conceptDescriptions as Anything[];
  assert.equal(incomplete.some((c) => c.id === NAMEPLATE_TEMPLATE_ID), false);
});

Deno.test("the XML writer takes a complete nameplate and an incomplete one", () => {
  const xml = environmentToXml(buildEnvironment(record(COMPLETE)).environment);
  assert.equal(xml.includes("<multiLanguageProperty>"), true);
  assert.equal(xml.includes(`<value>${NAMEPLATE_TEMPLATE_ID}</value>`), true);
  const incomplete = environmentToXml(buildEnvironment(record({ manufacturer_name: "Acme" })).environment);
  assert.equal(incomplete.includes(NAMEPLATE_TEMPLATE_ID), false);
});

Deno.test("loadDeviceRecord reads the two templates' elements once, and still loads where they cannot be read", async () => {
  const load = async (failing?: string) => {
    const queries: { table: string; filters: [string, unknown][] }[] = [];
    const from = (table: string) => {
      const query = { table, filters: [] as [string, unknown][] };
      queries.push(query);
      const rows = table === "devices"
        ? [record(null).device]
        : table === "idta_template_elements"
        ? [...NAMEPLATE_ROWS, ...CONTACT_ROWS]
        : [];
      const result = table === failing ? { data: null, error: { message: "permission denied" } } : { data: rows, error: null };
      const builder: Anything = Object.assign(Promise.resolve(result), {
        select: () => builder,
        eq: (column: string, value: unknown) => (query.filters.push([column, value]), builder),
        in: (column: string, value: unknown) => (query.filters.push([column, value]), builder),
      });
      return builder;
    };
    return { loaded: await loadDeviceRecord({ from }, "d1"), queries };
  };
  const { loaded, queries } = await load();
  assert.equal(queries.filter((q) => q.table === "idta_template_elements").map((q) => q.filters), [
    [["template_id", [NAMEPLATE_TEMPLATE_ID, CONTACT_INFORMATION_TEMPLATE_ID]]],
  ]);
  assert.equal(loaded?.elements?.length, NAMEPLATE_ROWS.length + CONTACT_ROWS.length);
  const { loaded: without } = await load("idta_template_elements");
  assert.equal(without?.elements, []);
});
