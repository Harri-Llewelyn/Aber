import {
  buildConceptDescriptions,
  buildEnvironment,
  type ConceptSource,
  type DeviceRecord,
  loadDeviceRecord,
} from "./shell.ts";
import { QUDT_UNIT_IDS } from "./qudtUnits.ts";
import { environmentToXml } from "./environmentXml.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
  ok(value: unknown, message: string) {
    if (!value) throw new Error(message);
  },
};

const MTC = "https://aber.local/semantics/mtconnect/v2.0/DataItemType/";
const QUDT_UNIT = "http://qudt.org/vocab/unit/";
const reference = (id: string) => ({
  type: "ExternalReference",
  keys: [{ type: "GlobalReference", value: id }],
});

const metric = (name: string, semanticId: string | null, extra = {}) => ({
  name,
  semantic_id: semanticId,
  datatype: 10,
  units: "CELSIUS",
  description: `The ${name} reading`,
  standard: "MTConnect",
  deprecated: false,
  ...extra,
});

type Rows = Parameters<typeof buildConceptDescriptions>[1];

/** The rows buildConceptDescriptions() reads, with the catalog a test names. */
const rows = (
  catalog: Record<string, unknown>[],
  extra: { definitions?: Rows["definitions"]; sources?: ConceptSource[]; schemas?: Rows["schemas"] } = {},
): Rows => ({
  catalog,
  templates: [],
  schemas: extra.schemas ?? [],
  definitions: extra.definitions ?? [],
  sources: extra.sources,
});

/** The IEC 61360 content of the one ConceptDescription made for `id` from `catalog`. */
function contentFor(
  id: string,
  catalog: Record<string, unknown>[],
  extra: Parameters<typeof rows>[1] = {},
) {
  const [concept] = buildConceptDescriptions([id], rows(catalog, extra));
  // deno-lint-ignore no-explicit-any
  return (concept as any).embeddedDataSpecifications[0].dataSpecificationContent;
}

// ---- unitId ------------------------------------------------------------------------------------

Deno.test("a unit that maps to a QUDT unit is exported as free text and as a reference to it", () => {
  const content = contentFor(MTC + "TEMPERATURE", [metric("Systems/TEMPERATURE", MTC + "TEMPERATURE")]);
  assert.equal(content.unit, "CELSIUS");
  assert.equal(content.unitId, reference(QUDT_UNIT + "DEG_C"));
  assert.equal(content.dataType, "REAL_MEASURE");
});

Deno.test("a unit the crosswalk maps to none keeps its free text and gets no unitId", () => {
  for (const unit of ["DEGREE_3D", "OTHER", "GALLON/MINUTE"]) {
    const content = contentFor(MTC + "POSITION", [metric("Axes/POSITION", MTC + "POSITION", { units: unit })]);
    assert.equal(content.unit, unit, unit);
    assert.equal("unitId" in JSON.parse(JSON.stringify(content)), false, unit);
  }
});

Deno.test("a unit that is not an MTConnect name gets no unitId, and no inherited key is read as one", () => {
  for (const unit of ["°C", "celsius", "constructor", "__proto__", "toString", ""]) {
    const content = contentFor(MTC + "TEMPERATURE", [metric("Systems/TEMPERATURE", MTC + "TEMPERATURE", { units: unit })]);
    assert.equal(content.unitId, undefined, unit);
  }
});

Deno.test("metrics that disagree on the unit export neither, and the data type is left unsaid", () => {
  const id = MTC + "TEMPERATURE";
  const content = contentFor(id, [
    metric("Systems/TEMPERATURE", id),
    metric("Spindle/TEMPERATURE", id, { units: "KELVIN" }),
  ]);
  assert.equal([content.unit, content.unitId, content.dataType], [undefined, undefined, undefined]);
});

Deno.test("metrics that agree on the unit export its reference once", () => {
  const id = MTC + "TEMPERATURE";
  const content = contentFor(id, [
    metric("Systems/TEMPERATURE", id),
    metric("Spindle/TEMPERATURE", id),
  ]);
  assert.equal(content.unitId, reference(QUDT_UNIT + "DEG_C"));
});

Deno.test("an id with no unit has no unitId", () => {
  const content = contentFor(MTC + "PART_COUNT", [
    metric("Controller/PART_COUNT", MTC + "PART_COUNT", { units: null, datatype: 8 }),
  ]);
  assert.equal([content.unit, content.unitId, content.dataType], [undefined, undefined, "INTEGER_COUNT"]);
});

Deno.test("the generated map holds only QUDT units, and the MTConnect names the issue starts with", () => {
  const ids = Object.values(QUDT_UNIT_IDS);
  assert.ok(ids.length > 50, "the map is nearly empty");
  assert.equal(ids.filter((id) => !id.startsWith(QUDT_UNIT)), []);
  assert.equal(
    ["CELSIUS", "MILLIMETER", "MILLIMETER/SECOND", "REVOLUTION/MINUTE"].map((n) => QUDT_UNIT_IDS[n]),
    ["DEG_C", "MilliM", "MilliM-PER-SEC", "REV-PER-MIN"].map((n) => QUDT_UNIT + n),
  );
});

// ---- the schemas ---------------------------------------------------------------------------------

// The shape check reads the vendored IDTA schema itself, so a name or a limit is the schema's.
// deno-lint-ignore no-explicit-any
type Schema = Record<string, any>;
const AAS_SCHEMA: Schema = JSON.parse(
  Deno.readTextFileSync(new URL("../../../../test-harness/schemas/AAS_V3_0_JSON_Schema.json", import.meta.url)),
);
const resolve = (ref: string): Schema => AAS_SCHEMA.definitions[ref.slice("#/definitions/".length)];

// The string pattern most of the schema's strings carry: XML 1.0 characters, as the schema writes it. A
// value is tested against the same set written as one character class over code points, which cannot
// backtrack as the schema's alternation of surrogate pairs can. The patterns of identifiers and
// language codes are not built here; the Python suite checks them with a validator.
const XML_CHARS_PATTERN =
  String.raw`^([\x09\x0a\x0d\x20-퟿-�]|\ud800[\udc00-\udfff]|[\ud801-\udbfe][\udc00-\udfff]|\udbff[\udc00-\udfff])*$`;
// deno-lint-ignore no-control-regex
const XML_CHARS = /^[\x09\x0a\x0d\x20-퟿-�\u{10000}-\u{10ffff}]*$/u;

/** What a value breaks in a schema: `$ref`, `allOf`, `properties`, `required`, `const`, enum, string and array limits. */
function violations(node: unknown, schema: Schema, path: string, out: string[] = []): string[] {
  if (schema.$ref) return violations(node, resolve(schema.$ref), path, out);
  for (const part of schema.allOf ?? []) violations(node, part, path, out);
  if ("const" in schema && schema.const !== node) out.push(`${path}: ${JSON.stringify(node)} is not ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(node)) out.push(`${path}: ${JSON.stringify(node)} is not in the enum`);
  if (schema.type === "string") {
    if (typeof node !== "string") return [...out, `${path}: not a string`];
    if (node.length < (schema.minLength ?? 0)) out.push(`${path}: shorter than ${schema.minLength}`);
    if (node.length > (schema.maxLength ?? Infinity)) out.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern === XML_CHARS_PATTERN && !XML_CHARS.test(node)) out.push(`${path}: breaks its pattern`);
  }
  if (schema.type === "array") {
    if (!Array.isArray(node)) return [...out, `${path}: not an array`];
    if (node.length < (schema.minItems ?? 0)) out.push(`${path}: fewer than ${schema.minItems} items`);
    node.forEach((item, i) => violations(item, schema.items, `${path}[${i}]`, out));
  }
  if (schema.properties || schema.required) {
    const object = node as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) out.push(`${path}: no ${key}`);
    for (const [key, sub] of Object.entries<Schema>(schema.properties ?? {})) {
      if (key in object) violations(object[key], sub, `${path}.${key}`, out);
    }
  }
  return out;
}

/** The keys a schema declares anywhere in its `allOf`: the schema has no `additionalProperties`. */
function declaredKeys(schema: Schema): string[] {
  if (schema.$ref) return declaredKeys(resolve(schema.$ref));
  return [...Object.keys(schema.properties ?? {}), ...(schema.allOf ?? []).flatMap(declaredKeys)];
}

/** A device with a mapped unit, an unmapped one and none, so each shape of the content is made. */
function deviceRecord(extra: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    device: { id: "d1", sparkplug_id: "dev1", name: "Mill 1" },
    config: [],
    links: [{ schema_id: "s1", submodel_key: null }],
    catalog: [
      metric("Systems/TEMPERATURE", MTC + "TEMPERATURE"),
      metric("Axes/ROTATION", MTC + "ANGLE", { units: "DEGREE_3D" }),
      metric("Controller/PART_COUNT", MTC + "PART_COUNT", { units: null, datatype: 8 }),
    ],
    gateway: null,
    nameplate: null,
    templates: [],
    schemas: [{
      id: "s1",
      schema_name: "Mill",
      semantic_id: null,
      schema_definition: { properties: { "Systems/TEMPERATURE": {}, "Axes/ROTATION": {}, "Controller/PART_COUNT": {} } },
    }],
    definitions: [],
    ...extra,
  };
}

Deno.test("every ConceptDescription an export carries is valid against the IDTA schema", () => {
  const { environment } = buildEnvironment(deviceRecord());
  // As the API sends it: a key left undefined is not a key.
  const descriptions: Record<string, unknown>[] = JSON.parse(JSON.stringify(environment)).conceptDescriptions;
  assert.equal(descriptions.length, 3);
  const allowed = declaredKeys(resolve("#/definitions/DataSpecificationIec61360"));
  for (const concept of descriptions) {
    assert.equal(violations(concept, resolve("#/definitions/ConceptDescription"), "conceptDescription"), []);
    // deno-lint-ignore no-explicit-any
    const content = (concept as any).embeddedDataSpecifications[0].dataSpecificationContent;
    // The schema reaches the content through a oneOf this checker does not follow, so it is held to
    // the IEC 61360 definition itself, and to the keys that definition declares.
    assert.equal(violations(content, resolve("#/definitions/DataSpecificationIec61360"), "content"), []);
    assert.equal(Object.keys(content).filter((key) => !allowed.includes(key)), []);
  }
  const [temperature] = descriptions.filter((c) => (c as { id: string }).id === MTC + "TEMPERATURE");
  // deno-lint-ignore no-explicit-any
  assert.equal((temperature as any).embeddedDataSpecifications[0].dataSpecificationContent.unitId, reference(QUDT_UNIT + "DEG_C"));
});

Deno.test("the checker is not vacuous: it refuses a unitId the schema refuses", () => {
  const definition = resolve("#/definitions/DataSpecificationIec61360");
  const base = { modelType: "DataSpecificationIec61360", preferredName: [{ language: "en", text: "x" }] };
  assert.equal(violations({ ...base, unitId: reference(QUDT_UNIT + "A") }, definition, "c"), []);
  assert.equal(
    violations({ ...base, unitId: { type: "ExternalReference", keys: [] } }, definition, "c").length > 0,
    true,
    "a reference with no key",
  );
  assert.equal(
    violations({ ...base, unitId: { type: "Sometimes", keys: [{ type: "GlobalReference", value: "x" }] } }, definition, "c").length > 0,
    true,
    "a reference of no type",
  );
});

Deno.test("the XML writer puts unitId after unit, with the reference's one key", () => {
  const { environment } = buildEnvironment(deviceRecord());
  const xml = environmentToXml(environment).replace(/>\s+</g, "><");
  const unit = "<unit>CELSIUS</unit>";
  const at = xml.indexOf(unit);
  assert.ok(at > 0, "no <unit>CELSIUS</unit>");
  const rest = xml.slice(at + unit.length);
  assert.ok(rest.startsWith("<unitId>"), `<unitId> does not follow <unit>: ${rest.slice(0, 80)}`);
  assert.equal(
    rest.slice(0, rest.indexOf("</unitId>") + "</unitId>".length),
    `<unitId><type>ExternalReference</type><keys><key><type>GlobalReference</type><value>${QUDT_UNIT}DEG_C</value></key></keys></unitId>`,
  );
  // The unmapped unit is written as text with no reference after it, so only the one unit maps.
  assert.ok(xml.includes("<unit>DEGREE_3D</unit>"), "no <unit>DEGREE_3D</unit>");
  assert.equal(xml.split("<unitId>").length - 1, 1, "one unitId, for the one unit that maps");
});

// ---- sourceOfDefinition ----------------------------------------------------------------------------

const ISO = "https://aber.local/semantics/iso22400/";
const QUDT_KIND = "http://qudt.org/vocab/quantitykind/";
const CITATION = 'OPC 40501-1 v1.02.0, Annex C.2.4 (informative): "Availability = APT / PBT".';
const QUDT_SOURCE = "QUDT 3.5.2, QUDT.org, CC BY 4.0";
const availability = metric("OEE/AVAILABILITY", ISO + "AVAILABILITY", { standard: "ISO 22400", units: null });
const availabilityDefined = [{
  semantic_id: ISO + "AVAILABILITY",
  name: "AVAILABILITY",
  definition: "Availability: actual production time (APT) as a share of planned busy time (PBT).",
  standard: "ISO 22400",
}];

Deno.test("a definition read from a vocabulary names the source the vocabulary gives it", () => {
  const content = contentFor(ISO + "AVAILABILITY", [availability], {
    definitions: availabilityDefined,
    sources: [{ semantic_id: ISO + "AVAILABILITY", source: CITATION }],
  });
  assert.equal(content.sourceOfDefinition, CITATION);
  assert.equal(content.definition[0].text, availabilityDefined[0].definition);
});

Deno.test("an id the sources hold no row for has no sourceOfDefinition", () => {
  const unsourced = contentFor(ISO + "AVAILABILITY", [availability], {
    definitions: availabilityDefined,
    sources: [{ semantic_id: ISO + "OEE", source: "another id's" }],
  });
  assert.equal(unsourced.sourceOfDefinition, undefined);
  assert.equal(
    contentFor(ISO + "AVAILABILITY", [availability], { definitions: availabilityDefined }).sourceOfDefinition,
    undefined,
  );
});

Deno.test("a catalog metric's own description is never credited to a vocabulary's source", () => {
  // No vocabulary defines the id, so the text is the metric's: a source row beside it would be a lie.
  const content = contentFor(ISO + "AVAILABILITY", [availability], {
    sources: [{ semantic_id: ISO + "AVAILABILITY", source: CITATION }],
  });
  assert.equal(content.definition[0].text, "The OEE/AVAILABILITY reading");
  assert.equal(content.sourceOfDefinition, undefined);
});

Deno.test("a QUDT kind with no description is defined as QUDT defines it, and sourced to QUDT", () => {
  const id = QUDT_KIND + "ActionTime";
  const content = contentFor(id, [metric("Custom/ACTION", id, { standard: null, units: null })], {
    sources: [{ semantic_id: id, source: QUDT_SOURCE }],
  });
  assert.equal(content.definition[0].text, "ActionTime, as QUDT defines it.");
  assert.equal(content.sourceOfDefinition, QUDT_SOURCE);
});

Deno.test("a concept only a schema references takes a source the same way", () => {
  const id = QUDT_KIND + "Temperature";
  const [concept] = buildConceptDescriptions([id], {
    ...rows([], { sources: [{ semantic_id: id, source: QUDT_SOURCE }] }),
    definitions: [{ semantic_id: id, name: "Temperature", definition: "Hot and cold.", standard: "QUDT" }],
  });
  // deno-lint-ignore no-explicit-any
  const content = (concept as any).embeddedDataSpecifications[0].dataSpecificationContent;
  assert.equal([content.definition[0].text, content.sourceOfDefinition], ["Hot and cold.", QUDT_SOURCE]);
});

Deno.test("an export with sources is valid against the IDTA schema, and the XML puts sourceOfDefinition after unitId", () => {
  const record = deviceRecord({
    catalog: [
      metric("Systems/TEMPERATURE", MTC + "TEMPERATURE"),
      availability,
    ],
    schemas: [{
      id: "s1",
      schema_name: "Mill",
      semantic_id: null,
      schema_definition: { properties: { "Systems/TEMPERATURE": {}, "OEE/AVAILABILITY": {} } },
    }],
    definitions: [
      { semantic_id: MTC + "TEMPERATURE", name: "TEMPERATURE", definition: "The temperature.", standard: "MTConnect" },
      ...availabilityDefined,
    ],
    sources: [
      { semantic_id: MTC + "TEMPERATURE", source: "MTConnect 2.7 XSD" },
      { semantic_id: ISO + "AVAILABILITY", source: CITATION },
    ],
  });
  const { environment } = buildEnvironment(record);
  const descriptions: Record<string, unknown>[] = JSON.parse(JSON.stringify(environment)).conceptDescriptions;
  for (const concept of descriptions) {
    assert.equal(violations(concept, resolve("#/definitions/ConceptDescription"), "conceptDescription"), []);
    // deno-lint-ignore no-explicit-any
    const content = (concept as any).embeddedDataSpecifications[0].dataSpecificationContent;
    assert.equal(violations(content, resolve("#/definitions/DataSpecificationIec61360"), "content"), []);
  }
  const xml = environmentToXml(environment).replace(/>\s+</g, "><");
  const after = "</unitId><sourceOfDefinition>MTConnect 2.7 XSD</sourceOfDefinition>";
  assert.ok(xml.includes(after), `no ${after}`);
  // A concept with no unit has no unitId, and its source follows the preferred name.
  assert.ok(xml.includes("</preferredName><sourceOfDefinition>"), "the KPI's source does not follow its name");
});

// ---- loading ---------------------------------------------------------------------------------------

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

const loadedTables = (): Record<string, object[]> => {
  const rows = deviceRecord();
  return {
    devices: [rows.device],
    device_schemas: [{ device_id: "d1", schema_id: "s1", submodel_key: null }],
    metric_catalog: rows.catalog,
    schemas: rows.schemas,
    concept_sources: [{ semantic_id: MTC + "TEMPERATURE", source: "MTConnect 2.7 XSD" }],
  };
};

Deno.test("loadDeviceRecord reads the sources once and carries them", async () => {
  const { client: fake, reads } = client(loadedTables());
  const loaded = await loadDeviceRecord(fake, "d1");
  assert.equal(reads.filter((t) => t === "concept_sources").length, 1);
  assert.equal(loaded?.sources, [{ semantic_id: MTC + "TEMPERATURE", source: "MTConnect 2.7 XSD" }]);
});

Deno.test("loadDeviceRecord still loads where the sources cannot be read, and no definition names one", async () => {
  const { client: fake } = client(loadedTables(), "concept_sources");
  const loaded = await loadDeviceRecord(fake, "d1");
  assert.equal(loaded?.sources, []);
  const { environment } = buildEnvironment(loaded as DeviceRecord);
  assert.equal(JSON.stringify(environment).includes("sourceOfDefinition"), false);
});
