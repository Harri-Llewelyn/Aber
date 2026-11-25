import { buildEnvironment, type DeviceRecord, loadDeviceRecord, NAMEPLATE_TEMPLATE_ID } from "../_shared/aas/shell.ts";
import {
  conceptDescriptionRoute,
  conceptDescriptionsOfTheShells,
  type DevicePage,
  pageOfConceptDescriptions,
} from "./conceptDescriptions.ts";
import { b64urlDecode, b64urlEncode } from "./http.ts";

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

// deno-lint-ignore no-explicit-any
type Anything = any;
type Row = Record<string, unknown>;

const TEMPERATURE = "https://example.test/concept/Temperature";
const PRESSURE = "https://example.test/concept/Pressure";
const GROUP_KPI = "https://example.test/site/GroupKpi";
const PRESS_LINE = "https://example.test/schema/PressLine";
const ARCHIVED_ONLY = "https://example.test/concept/OnlyOnAnArchivedDevice";
const UNMODELLED = "https://example.test/concept/InTheCatalogOnly";
const DESIGNATION = "0173-1#02-AAW338#001";
const LICENSED = "The licensed definition, which stays home until the licence is confirmed.";

const metric = (id: string, name: string, semanticId: string, extra: Row = {}) => ({
  id,
  name,
  semantic_id: semanticId,
  datatype: 10,
  units: "CELSIUS",
  description: `The ${name} reading.`,
  standard: null,
  deprecated: false,
  ...extra,
});

const schema = (id: string, metrics: string[], extra: Row = {}) => ({
  id,
  schema_name: `Schema_${id}`,
  semantic_id: null,
  description: null,
  status: "active",
  version: 1,
  schema_definition: { type: "object", properties: Object.fromEntries(metrics.map((m) => [m, {}])) },
  ...extra,
});

const device = (id: string, extra: Row = {}) => ({
  id,
  name: `Press ${id}`,
  sparkplug_id: `dev${id}`,
  gateway_id: null,
  is_archived: false,
  ...extra,
});

/**
 * Three devices: d1 and d2 published and sharing a metric's id, d3 archived. A site vocabulary that
 * does not share its definitions holds GROUP_KPI, which d2 carries. Every device's nameplate records
 * a product designation, so all three reference the template's DESIGNATION.
 */
function site(): Record<string, Row[]> {
  const unshared = { name: "Group naming standard", kind: "site_own", standard_name: null, standard_edition: null, definitions_shareable: false };
  return {
    devices: [device("d1"), device("d2"), device("d3", { is_archived: true })],
    device_nameplate: ["d1", "d2", "d3"].map((id) => ({
      device_id: id,
      manufacturer_product_designation: "Hydraulic press",
    })),
    device_schemas: [
      { device_id: "d1", schema_id: "s1", submodel_key: null },
      { device_id: "d2", schema_id: "s2", submodel_key: null },
      { device_id: "d3", schema_id: "s3", submodel_key: null },
    ],
    schemas: [
      schema("s1", ["Press/TEMPERATURE", "Press/PRESSURE"], { semantic_id: PRESS_LINE, description: "The press line." }),
      schema("s2", ["Press/PRESSURE", "Line/GROUP_KPI"]),
      schema("s3", ["Press/ARCHIVED"]),
    ],
    metric_catalog: [
      metric("m1", "Press/TEMPERATURE", TEMPERATURE),
      metric("m2", "Press/PRESSURE", PRESSURE),
      metric("m3", "Line/GROUP_KPI", GROUP_KPI, { description: LICENSED }),
      metric("m4", "Press/ARCHIVED", ARCHIVED_ONLY),
      metric("m5", "Press/UNMODELLED", UNMODELLED),
    ],
    idta_submodel_templates: [{
      template_id: NAMEPLATE_TEMPLATE_ID,
      id_short: "ManufacturerProductDesignation",
      semantic_id: DESIGNATION,
      description: "Short designation.",
    }],
    site_vocabulary_concepts: [{ semantic_id: GROUP_KPI, preferred_name: "Group KPI", definition: LICENSED, site_vocabularies: unshared }],
  };
}

/** A client over fixed tables that filters as PostgREST would, and records each read with its filters. */
function client(tables: Record<string, Row[]>) {
  const reads: { table: string; filters: Row }[] = [];
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const read = { table, filters: {} as Row };
    reads.push(read);
    let order: string | null = null;
    let limit: number | null = null;
    const builder: Anything = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        read.filters[column] = value;
        rows = rows.filter((r) => r[column] === value);
        return builder;
      },
      gt: (column: string, value: unknown) => {
        rows = rows.filter((r) => String(r[column]) > String(value));
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        rows = rows.filter((r) => values.includes(r[column]));
        return builder;
      },
      order: (column: string) => {
        order = column;
        return builder;
      },
      limit: (n: number) => {
        limit = n;
        return builder;
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        let out = order ? [...rows].sort((a, b) => String(a[order!]).localeCompare(String(b[order!]))) : rows;
        if (limit !== null) out = out.slice(0, limit);
        return Promise.resolve({ data: out, error: null }).then(resolve, reject);
      },
    };
    return builder;
  };
  return { client: { from }, reads, loaded: () => reads.filter((r) => r.table === "device_schemas").map((r) => r.filters.device_id) };
}

/** index.ts's devicePage(), over the test client: the devices that are not archived, by id. */
const devicePage: DevicePage = async (db, limit, cursor) => {
  let query = db.from("devices").select("id, sparkplug_id").eq("is_archived", false).order("id", { ascending: true })
    .limit(limit + 1);
  if (cursor) query = query.gt("id", cursor);
  const { data } = await query;
  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { page, nextCursor: hasMore ? String(page[page.length - 1].id) : null };
};

/** The route's answer as status and parsed body; null when the path is not a route of its own. */
async function get(tables: Record<string, Row[]>, path: string, { limit = 20, cursor = null as string | null } = {}) {
  const { client: db } = client(tables);
  const response = await conceptDescriptionRoute(db, path, limit, cursor, devicePage);
  return response && { status: response.status, body: await response.json() };
}

const byId = (id: string) => `/concept-descriptions/${b64urlEncode(id)}`;
const definitionOf = (cd: Anything) => cd.embeddedDataSpecifications[0].dataSpecificationContent.definition[0].text;

/** What aas-export's Environment carries for one device of `tables`, built as it builds it. */
async function exported(tables: Record<string, Row[]>, deviceId: string) {
  const { client: db } = client(tables);
  const record = await loadDeviceRecord(db, deviceId);
  return JSON.parse(JSON.stringify(buildEnvironment(record as DeviceRecord).environment)).conceptDescriptions;
}

// ---- Routing -------------------------------------------------------------------------------------

Deno.test("only the two ConceptDescription paths are this module's to answer", async () => {
  for (const path of ["/shells", "/submodels", "/", "/concept-description", "/concept-descriptionsX"]) {
    assert.equal(await get(site(), path), null, path);
  }
  assert.equal((await get(site(), "/concept-descriptions"))?.status, 200);
  assert.equal((await get(site(), byId(TEMPERATURE)))?.status, 200);
});

Deno.test("a path below a ConceptDescription, or a modifier, is a 404 in the specification's shape", async () => {
  for (const path of [`${byId(TEMPERATURE)}/value`, `${byId(TEMPERATURE)}/$value`, "/concept-descriptions/$value"]) {
    const answer = await get(site(), path);
    assert.equal(answer?.status, 404, path);
    assert.equal(answer?.body.messages[0].messageType, "Error", path);
  }
});

// ---- The identifier ------------------------------------------------------------------------------

Deno.test("an identifier is base64url, with or without its padding", async () => {
  const encoded = b64urlEncode(TEMPERATURE);
  assert.ok(!/[+/=]/.test(encoded), `${encoded} is not unpadded base64url`);
  assert.equal(b64urlDecode(encoded), TEMPERATURE);
  for (const path of [byId(TEMPERATURE), `${byId(TEMPERATURE)}${"=".repeat((4 - (encoded.length % 4)) % 4)}`]) {
    const answer = await get(site(), path);
    assert.equal(answer?.status, 200, path);
    assert.equal(answer?.body.id, TEMPERATURE, path);
    assert.equal(answer?.body.modelType, "ConceptDescription", path);
  }
});

Deno.test("an identifier that is not base64url, or not percent-decodable, is a 400 and reads nothing", async () => {
  for (const path of ["/concept-descriptions/!!!not-base64!!!", "/concept-descriptions/%E0%A4%A"]) {
    const { client: db, reads } = client(site());
    const response = await conceptDescriptionRoute(db, path, 20, null, devicePage);
    assert.equal(response?.status, 400, path);
    assert.equal((await response?.json()).messages[0].text, "cdIdentifier must be base64url-encoded", path);
    assert.equal(reads, [], path);
  }
});

// ---- 404 -----------------------------------------------------------------------------------------

Deno.test("an id no published shell references is a 404, whether or not the database holds it", async () => {
  // Nobody's id; a catalog metric no attached schema models; one only an archived device's shell carries.
  for (const id of ["https://example.test/nobody", UNMODELLED, ARCHIVED_ONLY]) {
    const answer = await get(site(), byId(id));
    assert.equal(answer?.status, 404, id);
    assert.equal(answer?.body.messages[0].text, `No concept description with identifier '${id}'`, id);
    assert.equal(answer?.body.messages[0].code, "404", id);
  }
});

// ---- The listing ---------------------------------------------------------------------------------

Deno.test("the listing holds every id the published shells reference, each once, in id order", async () => {
  const answer = await get(site(), "/concept-descriptions");
  const ids = answer?.body.result.map((cd: Anything) => cd.id);
  assert.equal(ids, [DESIGNATION, PRESSURE, TEMPERATURE, GROUP_KPI, PRESS_LINE].sort());
  assert.equal(answer?.body.paging_metadata, {});
});

Deno.test("each ConceptDescription is the one its device's export carries", async () => {
  const tables = site();
  const listed = (await get(tables, "/concept-descriptions"))?.body.result;
  const fromExports = new Map<string, unknown>();
  for (const id of ["d1", "d2"]) {
    for (const cd of await exported(tables, id)) if (!fromExports.has(cd.id)) fromExports.set(cd.id, cd);
  }
  assert.equal(listed.length, fromExports.size);
  for (const cd of listed) {
    assert.equal(cd, fromExports.get(cd.id), cd.id);
    assert.equal((await get(tables, byId(cd.id)))?.body, cd, cd.id);
  }
});

Deno.test("a listing reads each published device once and no archived one", async () => {
  const { client: db, loaded } = client(site());
  await conceptDescriptionsOfTheShells(db, devicePage);
  assert.equal(loaded(), ["d1", "d2"]);
});

Deno.test("fetching one id stops at the first shell that references it", async () => {
  const { client: db, loaded } = client(site());
  const [found] = await conceptDescriptionsOfTheShells(db, devicePage, TEMPERATURE);
  assert.equal(found.id, TEMPERATURE);
  assert.equal(loaded(), ["d1"]);
});

Deno.test("where two shells describe one id differently, the first device's is served", async () => {
  const tables = site();
  // Both schemas carry one schema-level id, each with a description of its own.
  tables.schemas[1] = { ...tables.schemas[1], semantic_id: PRESS_LINE, description: "The second line." };
  const answer = await get(tables, byId(PRESS_LINE));
  assert.equal(definitionOf(answer?.body), "The press line.");
  const listed = (await get(tables, "/concept-descriptions"))?.body.result.filter((cd: Anything) => cd.id === PRESS_LINE);
  assert.equal(listed.map(definitionOf), ["The press line."]);
});

// ---- Paging --------------------------------------------------------------------------------------

Deno.test("a cursor walks the listing a page at a time, without repeating or skipping", async () => {
  const all = (await get(site(), "/concept-descriptions"))?.body.result.map((cd: Anything) => cd.id);
  const walked: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const answer: Anything = await get(site(), "/concept-descriptions", { limit: 2, cursor });
    assert.equal(answer.status, 200);
    assert.ok(answer.body.result.length <= 2, "a page holds more than limit");
    walked.push(...answer.body.result.map((cd: Anything) => cd.id));
    cursor = answer.body.paging_metadata.cursor ?? null;
    pages += 1;
  } while (cursor && pages < 10);
  assert.equal(walked, all);
  assert.equal(pages, 3);
});

Deno.test("the last page leaves the cursor out, and a page names the id it ends on", () => {
  const all = ["a", "b", "c"].map((id) => ({ id }));
  assert.equal(pageOfConceptDescriptions(all, 2, null), { result: [{ id: "a" }, { id: "b" }], cursor: b64urlEncode("b") });
  assert.equal(pageOfConceptDescriptions(all, 2, "b"), { result: [{ id: "c" }], cursor: null });
  assert.equal(pageOfConceptDescriptions(all, 3, null).cursor, null);
  assert.equal(pageOfConceptDescriptions(all, 2, "c"), { result: [], cursor: null });
});

Deno.test("a cursor that is not base64url is a 400", async () => {
  const answer = await get(site(), "/concept-descriptions", { cursor: "!!!" });
  assert.equal(answer?.status, 400);
  assert.equal(answer?.body.messages[0].messageType, "Error");
});

// ---- The licence rule ----------------------------------------------------------------------------

Deno.test("an unshared vocabulary's id is named by the file and its licensed text is served by neither route", async () => {
  const tables = site();
  const one = (await get(tables, byId(GROUP_KPI)))?.body;
  const content = one.embeddedDataSpecifications[0].dataSpecificationContent;
  assert.equal(content.preferredName[0].text, "Group KPI");
  assert.equal(content.definition[0].text, "Group KPI, as Group naming standard defines it.");
  assert.equal(JSON.stringify(one).includes(LICENSED), false);
  assert.equal(JSON.stringify((await get(tables, "/concept-descriptions"))?.body).includes(LICENSED), false);
});

Deno.test("once the licence is confirmed, both routes serve the file's text, as the export does", async () => {
  const tables = site();
  tables.site_vocabulary_concepts[0].site_vocabularies = {
    ...(tables.site_vocabulary_concepts[0].site_vocabularies as Row),
    definitions_shareable: true,
  };
  assert.equal(definitionOf((await get(tables, byId(GROUP_KPI)))?.body), LICENSED);
  const listed = (await get(tables, "/concept-descriptions"))?.body.result.find((cd: Anything) => cd.id === GROUP_KPI);
  assert.equal(definitionOf(listed), LICENSED);
});
