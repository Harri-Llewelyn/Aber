import {
  buildEnvironment,
  type DeviceRecord,
  loadDeviceRecord,
  OPC_MACHINERY,
} from "../_shared/aas/shell.ts";
import { assetLinksOf, discoveryRoute } from "./discovery.ts";
import { b64urlEncode, ClientMistake } from "./http.ts";

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

const PRODUCT = "https://example.test/products/press-200";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const wire = (n: number) => `dev${String(n).padStart(21, "0")}`;
const shellId = (n: number) => `https://aber.local/ids/asset/${wire(n)}/shell`;
const globalId = (n: number) => `https://aber.local/ids/asset/${wire(n)}`;

const device = (n: number, extra: Row = {}) => ({
  id: uuid(n),
  name: `Press ${n}`,
  sparkplug_id: wire(n),
  gateway_id: null,
  is_archived: false,
  shadow_of: null,
  ...extra,
});

const birth = (n: number, metric: string, column: string, value: unknown) => ({
  asset_id: wire(n),
  metric_name: metric,
  val_string: null,
  val_double: null,
  val_bool: null,
  [column]: value,
});

/**
 * One device for each place a serial number is read from, and a replay lane and an archived device
 * that repeat a published one's.
 *
 * 1: the operator's nameplate, with the product URI 2 shares.
 * 2: published as SERIAL_NUMBER.
 * 3: published under a metric carrying the OPC 40001 SerialNumber id; its operator's differs and loses.
 * 4: published under a metric carrying that id as a further one, which 3's metric answers before.
 * 5: published as a number.
 * 6: a replay lane of 2, whose birth repeats 2's serial number.
 * 7: archived, publishing 2's serial number.
 */
function site(): Record<string, Row[]> {
  return {
    devices: [
      device(1),
      device(2),
      device(3),
      device(4),
      device(5),
      device(6, { name: "Press 2 (replay)", shadow_of: uuid(2) }),
      device(7, { is_archived: true }),
    ],
    device_nameplate: [
      { device_id: uuid(1), serial_number: "SN-1", uri_of_the_product: PRODUCT },
      { device_id: uuid(2), uri_of_the_product: PRODUCT },
      { device_id: uuid(3), serial_number: "SN-WRITTEN-DOWN" },
    ],
    metric_catalog: [
      { id: "m1", name: "Machine/SerialNumber", semantic_id: OPC_MACHINERY.SerialNumber, datatype: 12 },
      { id: "m2", name: "Plc/Serial", semantic_id: "https://example.test/vendor/serial", datatype: 12 },
    ],
    metric_semantic_ids: [{ metric_id: "m2", semantic_id: OPC_MACHINERY.SerialNumber }],
    asset_config: [
      birth(2, "SERIAL_NUMBER", "val_string", "SN-2"),
      birth(3, "Machine/SerialNumber", "val_string", "SN-3"),
      birth(4, "Plc/Serial", "val_string", "SN-4"),
      birth(5, "SERIAL_NUMBER", "val_double", 12345),
      birth(6, "SERIAL_NUMBER", "val_string", "SN-2"),
      birth(7, "SERIAL_NUMBER", "val_string", "SN-2"),
    ],
  };
}

/** A client over fixed tables that filters as PostgREST would, and counts the shells it is asked to build. */
function client(tables: Record<string, Row[]>) {
  const built: string[] = [];
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let order: string | null = null;
    let limit: number | null = null;
    const builder: Anything = {
      select: (columns: string) => {
        if (table === "devices" && columns === "*") built.push("device");
        return builder;
      },
      eq: (column: string, value: unknown) => {
        rows = rows.filter((r) => r[column] === value);
        return builder;
      },
      is: (column: string, value: unknown) => {
        rows = rows.filter((r) => (r[column] ?? null) === value);
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
  return { client: { from }, built };
}

const asked = (...links: unknown[]) => links.map((link) => `assetIds=${b64urlEncode(JSON.stringify(link))}`).join("&");

/** The route's answer as status and parsed body; null when the path is not one of its own. */
async function get(tables: Record<string, Row[]>, path: string, { query = "", limit = 20, cursor = null as string | null } = {}) {
  const { client: db } = client(tables);
  const url = new URL(`http://aas-api.test${path}${query ? `?${query}` : ""}`);
  const response = await discoveryRoute(db, path, url, limit, cursor);
  return response && { status: response.status, body: await response.json() };
}

const lookup = async (...links: unknown[]) => (await get(site(), "/lookup/shells", { query: asked(...links) }))?.body.result;

async function shellOf(tables: Record<string, Row[]>, n: number) {
  const { client: db } = client(tables);
  return buildEnvironment(await loadDeviceRecord(db, uuid(n)) as DeviceRecord);
}

// ---- Routing -------------------------------------------------------------------------------------

Deno.test("only Discovery's paths are this module's to answer", async () => {
  for (const path of ["/shells", "/lookup", "/lookup/shellsX", "/shell-descriptors", "/"]) {
    assert.equal(await get(site(), path), null, path);
  }
  assert.equal((await get(site(), "/lookup/shells"))?.status, 200);
  assert.equal((await get(site(), `/lookup/shells/${b64urlEncode(shellId(1))}/more`))?.status, 404);
});

// ---- Where a serial number is read from -----------------------------------------------------------

Deno.test("a serial number finds its shell from wherever the shell takes it", async () => {
  const cases: [string, number][] = [["SN-1", 1], ["SN-2", 2], ["SN-3", 3], ["12345", 5]];
  for (const [serial, n] of cases) {
    assert.equal(await lookup({ name: "partInstanceId", value: serial }), [shellId(n)], serial);
  }
});

Deno.test("a metric carrying the serial number's id as a further one answers when none carries it as its own", async () => {
  // As the shell reads it: a metric with the id as its own answers first, so 4's answers nothing here.
  assert.equal(await lookup({ name: "partInstanceId", value: "SN-4" }), []);
  const tables = site();
  tables.metric_catalog = tables.metric_catalog.filter((metric) => metric.id !== "m1");
  const found = async (serial: string) =>
    (await get(tables, "/lookup/shells", { query: asked({ name: "partInstanceId", value: serial }) }))?.body.result;
  assert.equal(await found("SN-4"), [shellId(4)]);
  // And 3's own metric no longer answers, so its operator's number is the one its shell carries.
  assert.equal(await found("SN-WRITTEN-DOWN"), [shellId(3)]);
  assert.equal(await found("SN-3"), []);
});

Deno.test("an operator's serial number the device's own replaces is not found, as the shell does not carry it", async () => {
  assert.equal(await lookup({ name: "partInstanceId", value: "SN-WRITTEN-DOWN" }), []);
});

Deno.test("each link found is one the shell carries", async () => {
  for (const n of [1, 2, 3, 4, 5]) {
    const shell = await shellOf(site(), n);
    for (const link of assetLinksOf(shell)) {
      const found = await lookup({ name: link.name, value: link.value });
      assert.ok(found.includes(shellId(n)), `${link.name} ${link.value} does not find shell ${n}`);
    }
  }
});

// ---- What is not indexed -------------------------------------------------------------------------

Deno.test("a replay lane is not indexed, though its birth repeats its original's serial number", async () => {
  assert.equal(await lookup({ name: "partInstanceId", value: "SN-2" }), [shellId(2)]);
  assert.equal(await lookup({ name: "sparkplugId", value: wire(6) }), []);
  assert.equal(await lookup({ name: "globalAssetId", value: globalId(6) }), []);
  const links = await get(site(), `/lookup/shells/${b64urlEncode(shellId(6))}`);
  assert.equal(links?.status, 404);
  assert.equal(links?.body.messages[0].text, `No shell with identifier '${shellId(6)}' is indexed by Discovery`);
});

Deno.test("an archived device is not indexed", async () => {
  assert.equal(await lookup({ name: "sparkplugId", value: wire(7) }), []);
  assert.equal((await get(site(), `/lookup/shells/${b64urlEncode(shellId(7))}`))?.status, 404);
});

// ---- Matching ------------------------------------------------------------------------------------

Deno.test("every link asked for must hold, each by its exact name and value", async () => {
  assert.equal(await lookup({ name: "partInstanceId", value: "SN-1" }, { name: "sparkplugId", value: wire(1) }), [shellId(1)]);
  assert.equal(await lookup({ name: "partInstanceId", value: "SN-1" }, { name: "sparkplugId", value: wire(2) }), []);
  assert.equal(await lookup({ name: "globalAssetId", value: globalId(3) }), [shellId(3)]);
  assert.equal(await lookup({ name: "PartInstanceId", value: "SN-1" }), []);
  assert.equal(await lookup({ name: "partInstanceId", value: "sn-1" }), []);
  assert.equal(await lookup({ name: "serialNumber", value: "SN-1" }), []);
  assert.equal(await lookup({ name: "globalAssetId", value: "https://elsewhere.test/asset/1" }), []);
});

Deno.test("a product URI many devices share pages by device", async () => {
  const link = { name: "uriOfTheProduct", value: PRODUCT };
  const first: Anything = await get(site(), "/lookup/shells", { query: asked(link), limit: 1 });
  assert.equal(first.body.result, [shellId(1)]);
  assert.equal(first.body.paging_metadata.cursor, uuid(1));
  const second: Anything = await get(site(), "/lookup/shells", { query: asked(link), limit: 1, cursor: uuid(1) });
  assert.equal(second.body, { paging_metadata: {}, result: [shellId(2)] });
});

Deno.test("with no link asked for, every indexed shell is listed, a page at a time", async () => {
  const all = await get(site(), "/lookup/shells");
  assert.equal(all?.body.result, [1, 2, 3, 4, 5].map(shellId));
  const first: Anything = await get(site(), "/lookup/shells", { limit: 3 });
  assert.equal(first.body.result, [1, 2, 3].map(shellId));
  const rest: Anything = await get(site(), "/lookup/shells", { limit: 3, cursor: first.body.paging_metadata.cursor });
  assert.equal(rest.body, { paging_metadata: {}, result: [4, 5].map(shellId) });
});

Deno.test("a lookup builds only the shells its candidates name", async () => {
  const { client: db, built } = client(site());
  const url = new URL(`http://aas-api.test/lookup/shells?${asked({ name: "partInstanceId", value: "SN-3" })}`);
  await discoveryRoute(db, "/lookup/shells", url, 20, null);
  assert.equal(built.length, 1);
});

// ---- The request ---------------------------------------------------------------------------------

Deno.test("assetIds that are not encoded SpecificAssetIds are the client's mistake; an encoded list is read", async () => {
  for (const query of ["assetIds=!!!", `assetIds=${b64urlEncode("not json")}`, asked({ name: "partInstanceId" }), asked({ value: "SN-1" }), asked("SN-1")]) {
    let thrown: unknown = null;
    try {
      await get(site(), "/lookup/shells", { query });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof ClientMistake, `${query}: expected a ClientMistake, got ${thrown}`);
  }
  const list = `assetIds=${b64urlEncode(JSON.stringify([{ name: "partInstanceId", value: "SN-1" }, { name: "sparkplugId", value: wire(1) }]))}`;
  assert.equal((await get(site(), "/lookup/shells", { query: list }))?.body.result, [shellId(1)]);
});

Deno.test("a cursor that names no device is the client's mistake", async () => {
  let thrown: unknown = null;
  try {
    await get(site(), "/lookup/shells", { query: asked({ name: "partInstanceId", value: "SN-1" }), cursor: "page-2" });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof ClientMistake, `expected a ClientMistake, got ${thrown}`);
});

// ---- One shell's links ---------------------------------------------------------------------------

Deno.test("one shell's links are its globalAssetId and its specificAssetIds, as the shell carries them", async () => {
  const shell: Anything = (await shellOf(site(), 1)).shell;
  const answer = await get(site(), `/lookup/shells/${b64urlEncode(shellId(1))}`);
  assert.equal(answer?.status, 200);
  assert.equal(answer?.body, [
    { name: "globalAssetId", value: globalId(1) },
    ...shell.assetInformation.specificAssetIds,
  ]);
  assert.equal(answer?.body.map((link: Anything) => link.name), ["globalAssetId", "partInstanceId", "uriOfTheProduct", "sparkplugId"]);
  assert.equal((await get(site(), "/lookup/shells/!!!"))?.status, 400);
  assert.equal((await get(site(), `/lookup/shells/${b64urlEncode(globalId(1))}`))?.status, 404);
});
