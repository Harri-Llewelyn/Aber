import {
  BASE_IRI,
  buildEnvironment,
  buildSpecificAssetIds,
  type DeviceRecord,
  OPC_MACHINERY,
  SPECIFIC_ASSET_ID_NAMES,
} from "./shell.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

const SERIAL_IRDI = "0112/2///61987#ABA951#009";
const URI_IRDI = "0112/2///61987#ABN590#002";
const reference = (id: string) => ({
  type: "ExternalReference",
  keys: [{ type: "GlobalReference", value: id }],
});

/** One device's rows, with the two Nameplate templates the identifiers take their semantic ids from. */
function record(
  parts: Partial<Pick<DeviceRecord, "config" | "catalog" | "nameplate">> & {
    device?: Record<string, unknown>;
  } = {},
): DeviceRecord {
  return {
    device: { id: "d1", sparkplug_id: "dev1", name: "Lathe 1", ...parts.device },
    config: parts.config ?? [],
    links: [],
    catalog: parts.catalog ?? [],
    gateway: null,
    nameplate: parts.nameplate ?? null,
    templates: [
      { id_short: "SerialNumber", semantic_id: SERIAL_IRDI },
      { id_short: "URIOfTheProduct", semantic_id: URI_IRDI },
    ],
    schemas: [],
    definitions: [],
  };
}

/** `assetInformation` as a consumer reads it: through JSON, so an undefined key is not there. */
// deno-lint-ignore no-explicit-any
const assetInformation = (rows: DeviceRecord): any =>
  JSON.parse(JSON.stringify(buildEnvironment(rows).shell.assetInformation));

/** The Nameplate's own property, which the identifiers must agree with. */
const nameplateValue = (rows: DeviceRecord, idShort: string): unknown =>
  // deno-lint-ignore no-explicit-any
  ((buildEnvironment(rows).submodels as any[])
    .find((s) => s.idShort === "DigitalNameplate").submodelElements as { idShort: string; value?: string }[])
    .find((e) => e.idShort === idShort)?.value;

const NAMEPLATE = {
  serial_number: "SN-0042",
  uri_of_the_product: "https://example.com/products/lathe/0042",
};

Deno.test("a shell names its asset by serial number, product URI and Sparkplug id, in that order", () => {
  const info = assetInformation(record({ nameplate: NAMEPLATE }));
  assert.equal(info.specificAssetIds, [
    { name: "partInstanceId", value: "SN-0042", semanticId: reference(SERIAL_IRDI) },
    {
      name: "uriOfTheProduct",
      value: "https://example.com/products/lathe/0042",
      semanticId: reference(URI_IRDI),
    },
    { name: "sparkplugId", value: "dev1" },
  ]);
  assert.equal(Object.values(SPECIFIC_ASSET_ID_NAMES), ["partInstanceId", "uriOfTheProduct", "sparkplugId"]);
});

Deno.test("the shell's own id and globalAssetId are unchanged by the identifiers", () => {
  const rows = record({ nameplate: NAMEPLATE });
  const built = buildEnvironment(rows);
  assert.equal(assetInformation(rows).globalAssetId, `${BASE_IRI}dev1`);
  assert.equal(built.shell.id, `${BASE_IRI}dev1/shell`);
  assert.equal(
    // deno-lint-ignore no-explicit-any
    (built.submodels as any[]).every((s) => s.id.startsWith(`${BASE_IRI}dev1/submodel/`)),
    true,
  );
});

Deno.test("a missing serial number is left out, and the others stay in order", () => {
  const info = assetInformation(record({ nameplate: { uri_of_the_product: NAMEPLATE.uri_of_the_product } }));
  assert.equal(info.specificAssetIds.map((id: { name: string }) => id.name), ["uriOfTheProduct", "sparkplugId"]);
});

Deno.test("a missing product URI is left out, and the others stay in order", () => {
  const info = assetInformation(record({ nameplate: { serial_number: NAMEPLATE.serial_number } }));
  assert.equal(info.specificAssetIds.map((id: { name: string }) => id.name), ["partInstanceId", "sparkplugId"]);
});

Deno.test("a device with no nameplate row still names its Sparkplug id, and an empty nameplate value counts as none", () => {
  for (const nameplate of [null, { serial_number: "", uri_of_the_product: "   " }]) {
    const info = assetInformation(record({ nameplate }));
    assert.equal(info.specificAssetIds, [{ name: "sparkplugId", value: "dev1" }]);
  }
});

Deno.test("a shell with no identifier at all has no specificAssetIds key, as the schema's minItems is 1", () => {
  const info = assetInformation(record({ device: { sparkplug_id: null } }));
  assert.equal("specificAssetIds" in info, false);
  assert.equal(Object.keys(info), ["assetKind", "globalAssetId"]);
});

Deno.test("a replay lane carries no specificAssetIds, whatever its DBIRTH published", () => {
  const lane = record({
    device: { shadow_of: "d0" },
    nameplate: NAMEPLATE,
    config: [{ metric_name: "SERIAL_NUMBER", val_string: "SN-ORIGINAL" }],
  });
  const info = assetInformation(lane);
  assert.equal("specificAssetIds" in info, false);
  // Its own identity is untouched: only the list is withheld.
  assert.equal(info.globalAssetId, `${BASE_IRI}dev1`);
  // The same rows on a device that is not a lane do carry them.
  assert.equal(
    assetInformation({ ...lane, device: { ...lane.device, shadow_of: null } }).specificAssetIds.length,
    3,
  );
});

Deno.test("the serial number is the Nameplate's: the device's published value, then the operator's", () => {
  const published = {
    catalog: [{
      name: "Machine/SerialNumber",
      semantic_id: OPC_MACHINERY.SerialNumber,
      datatype: 12,
      description: "Serial",
      standard: null,
      deprecated: false,
    }],
    config: [{ metric_name: "Machine/SerialNumber", val_string: "SN-PUBLISHED" }],
  };
  const serial = (rows: DeviceRecord) =>
    // deno-lint-ignore no-explicit-any
    assetInformation(rows).specificAssetIds.find((id: any) => id.name === "partInstanceId")?.value;

  // Published and stored: the device's answer wins, and the Nameplate shows the same.
  const both = record({ ...published, nameplate: NAMEPLATE });
  assert.equal(serial(both), "SN-PUBLISHED");
  assert.equal(serial(both), nameplateValue(both, "SerialNumber"));

  // Stored only.
  const stored = record({ nameplate: NAMEPLATE });
  assert.equal(serial(stored), "SN-0042");
  assert.equal(serial(stored), nameplateValue(stored, "SerialNumber"));

  // The pre-semantic-id fallback: a birth value under the literal name SERIAL_NUMBER.
  const legacy = record({ config: [{ metric_name: "SERIAL_NUMBER", val_string: "SN-LEGACY" }] });
  assert.equal(serial(legacy), "SN-LEGACY");
  assert.equal(serial(legacy), nameplateValue(legacy, "SerialNumber"));
});

Deno.test("a serial number a device publishes as a number is written as text", () => {
  const rows = record({ config: [{ metric_name: "SERIAL_NUMBER", val_double: 12345 }] });
  // deno-lint-ignore no-explicit-any
  assert.equal(assetInformation(rows).specificAssetIds.find((id: any) => id.name === "partInstanceId")?.value, "12345");
});

Deno.test("a value longer than the schema allows is left out, not cut", () => {
  const info = assetInformation(record({ nameplate: { serial_number: "x".repeat(2049) } }));
  assert.equal(info.specificAssetIds.map((id: { name: string }) => id.name), ["sparkplugId"]);
  assert.equal(
    assetInformation(record({ nameplate: { serial_number: "x".repeat(2048) } })).specificAssetIds[0].value.length,
    2048,
  );
});

Deno.test("specificAssetIds can be built for a shell that is not a device", () => {
  // No Sparkplug id and no serial number: an area names itself by its own tag.
  assert.equal(
    buildSpecificAssetIds([
      { name: "operatorTag", value: "AREA-7" },
      { name: "partInstanceId", value: null },
      { name: "uriOfTheProduct", value: undefined },
    ]),
    [{ name: "operatorTag", value: "AREA-7" }],
  );
  assert.equal(buildSpecificAssetIds([]), undefined);
  assert.equal(buildSpecificAssetIds([{ name: "operatorTag", value: "" }]), undefined);
});

// The shape check reads the vendored IDTA schema itself, so a name or a limit is the schema's.
// deno-lint-ignore no-explicit-any
type Schema = Record<string, any>;
const AAS_SCHEMA: Schema = JSON.parse(
  Deno.readTextFileSync(new URL("../../../../test-harness/schemas/AAS_V3_0_JSON_Schema.json", import.meta.url)),
);

const resolve = (ref: string): Schema => AAS_SCHEMA.definitions[ref.slice("#/definitions/".length)];

// The one string pattern the schema's identifiers carry: XML 1.0 characters. A pattern that is not
// this one is reported, not skipped.
const XML_CHARS =
  /^([\x09\x0a\x0d\x20-\ud7ff\ue000-\ufffd]|\ud800[\udc00-\udfff]|[\ud801-\udbfe][\udc00-\udfff]|\udbff[\udc00-\udfff])*$/;

/** What a value breaks in a schema: `$ref`, `allOf`, `properties`, `required`, enum, string and array limits. */
function violations(node: unknown, schema: Schema, path: string, out: string[] = []): string[] {
  if (schema.$ref) return violations(node, resolve(schema.$ref), path, out);
  for (const part of schema.allOf ?? []) violations(node, part, path, out);
  if (schema.enum && !schema.enum.includes(node)) out.push(`${path}: ${JSON.stringify(node)} is not in the enum`);
  if (schema.type === "string") {
    if (typeof node !== "string") return [...out, `${path}: not a string`];
    if (node.length < (schema.minLength ?? 0)) out.push(`${path}: shorter than ${schema.minLength}`);
    if (node.length > (schema.maxLength ?? Infinity)) out.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && schema.pattern !== XML_CHARS.source) out.push(`${path}: has a pattern this test does not know`);
    else if (schema.pattern && !XML_CHARS.test(node)) out.push(`${path}: breaks its pattern`);
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

Deno.test("assetInformation, with and without identifiers, is valid against the IDTA schema", () => {
  const rowsets = [
    record({ nameplate: NAMEPLATE }),
    record({ nameplate: { serial_number: "SN-0042" } }),
    record({ nameplate: null }),
    record({ device: { shadow_of: "d0" }, nameplate: NAMEPLATE }),
    record({ device: { sparkplug_id: null } }),
  ];
  for (const rows of rowsets) {
    const info = assetInformation(rows);
    assert.equal(violations(info, resolve("#/definitions/AssetInformation"), "assetInformation"), []);
    const allowed = declaredKeys(resolve("#/definitions/SpecificAssetId"));
    for (const id of info.specificAssetIds ?? []) {
      assert.equal(Object.keys(id).filter((key) => !allowed.includes(key)), []);
    }
  }
  // The checker is not vacuous: it refuses what the schema refuses.
  const refused = violations(
    { assetKind: "Instance", specificAssetIds: [{ name: "x".repeat(65), value: "" }, { value: "v" }] },
    resolve("#/definitions/AssetInformation"),
    "assetInformation",
  );
  assert.equal(refused.length, 3);
  assert.equal(
    violations({ assetKind: "Instance", specificAssetIds: [] }, resolve("#/definitions/AssetInformation"), "a").length,
    1,
  );
});
