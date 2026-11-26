import { buildEnvironment, type DeviceRecord, loadDeviceRecord } from "../_shared/aas/shell.ts";
import { b64urlEncode, ClientMistake } from "./http.ts";
import { registryRoute, shellDescriptor } from "./registry.ts";

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

const SERVICE = "https://api.example.test/functions/v1/aas-api";
const PRESS_LINE = "https://example.test/schema/PressLine";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const wire = (n: number) => `dev${String(n).padStart(21, "0")}`;

const device = (n: number, extra: Row = {}) => ({
  id: uuid(n),
  name: `Press ${n}`,
  sparkplug_id: wire(n),
  gateway_id: null,
  is_archived: false,
  shadow_of: null,
  ...extra,
});

/**
 * Four published devices, one archived, and a replay lane of the first. Device 1 has a nameplate and
 * a schema with a semantic id, so its shell has three submodels.
 */
function site(): Record<string, Row[]> {
  return {
    devices: [
      device(1),
      device(2),
      device(3),
      device(4, { is_archived: true }),
      device(5, { name: "Press 1 (replay)", shadow_of: uuid(1) }),
      device(6),
    ],
    device_nameplate: [{ device_id: uuid(1), serial_number: "SN-1", manufacturer_name: "Aber Presses" }],
    device_schemas: [
      { device_id: uuid(1), schema_id: "s1", submodel_key: null },
      { device_id: uuid(5), schema_id: "s1", submodel_key: null },
    ],
    schemas: [{
      id: "s1",
      schema_name: "Press",
      semantic_id: PRESS_LINE,
      status: "active",
      version: 1,
      schema_definition: { type: "object", properties: { "Press/TEMPERATURE": {} } },
    }],
    metric_catalog: [{ id: "m1", name: "Press/TEMPERATURE", semantic_id: "https://example.test/T", datatype: 10 }],
    asset_config: [{ asset_id: wire(5), metric_name: "SERIAL_NUMBER", val_string: "SN-1" }],
  };
}

/** A client over fixed tables that filters as PostgREST would. */
function client(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let order: string | null = null;
    let limit: number | null = null;
    const builder: Anything = {
      select: () => builder,
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
  return { from };
}

/** The route's answer as status and parsed body; null when the path is not one of its own. */
async function get(tables: Record<string, Row[]>, path: string, { limit = 20, cursor = null as string | null, query = "" } = {}) {
  const url = new URL(`http://aas-api.test${path}${query}`);
  const response = await registryRoute(client(tables), path, url, limit, cursor, SERVICE);
  return response && { status: response.status, body: await response.json() };
}

/** The shell `/shells` serves for one device, built as it builds it. */
async function shellOf(tables: Record<string, Row[]>, n: number) {
  const record = await loadDeviceRecord(client(tables), uuid(n));
  return buildEnvironment(record as DeviceRecord);
}

const shellId = (n: number) => `https://aber.local/ids/asset/${wire(n)}/shell`;
const byId = (id: string) => `/shell-descriptors/${b64urlEncode(id)}`;

// ---- Routing -------------------------------------------------------------------------------------

Deno.test("only the Registry's paths are this module's to answer", async () => {
  for (const path of ["/shells", "/shell-descriptor", "/shell-descriptorsX", "/lookup/shells", "/"]) {
    assert.equal(await get(site(), path), null, path);
  }
  assert.equal((await get(site(), "/shell-descriptors"))?.status, 200);
});

// ---- The projection ------------------------------------------------------------------------------

Deno.test("a descriptor names the shell as /shells serves it, and where to read it", async () => {
  const built = await shellOf(site(), 1);
  const descriptor: Anything = shellDescriptor(built, SERVICE);
  const shell: Anything = built.shell;
  assert.equal(descriptor.id, shell.id);
  assert.equal(descriptor.idShort, shell.idShort);
  assert.equal(descriptor.assetKind, "Instance");
  assert.equal(descriptor.globalAssetId, shell.assetInformation.globalAssetId);
  assert.equal(descriptor.specificAssetIds, shell.assetInformation.specificAssetIds);
  assert.equal(descriptor.endpoints, [{
    interface: "AAS-3.0",
    protocolInformation: {
      href: `${SERVICE}/shells/${b64urlEncode(shell.id)}`,
      endpointProtocol: "HTTPS",
      endpointProtocolVersion: ["1.1"],
    },
  }]);
});

Deno.test("each submodel the shell references is described inside it, in the shell's order", async () => {
  const built = await shellOf(site(), 1);
  const descriptor: Anything = shellDescriptor(built, SERVICE);
  assert.equal(
    descriptor.submodelDescriptors.map((d: Anything) => d.id),
    (built.shell as Anything).submodels.map((ref: Anything) => ref.keys[0].value),
  );
  assert.ok(built.submodels.length >= 3, "the fixture's shell has fewer submodels than the test needs");
  built.submodels.forEach((submodel: Anything, at) => {
    const described = descriptor.submodelDescriptors[at];
    assert.equal(described.idShort, submodel.idShort, submodel.id);
    assert.equal(described.semanticId, submodel.semanticId, submodel.id);
    assert.equal(described.administration, submodel.administration, submodel.id);
    assert.equal(described.endpoints[0].interface, "SUBMODEL-3.0", submodel.id);
    assert.equal(described.endpoints[0].protocolInformation.href, `${SERVICE}/submodels/${b64urlEncode(submodel.id)}`, submodel.id);
    assert.ok(!("submodelElements" in described), `${submodel.id}'s descriptor carries its elements`);
  });
  const telemetry = descriptor.submodelDescriptors.find((d: Anything) => d.idShort === "OperationalTelemetry");
  assert.equal(telemetry.semanticId.keys[0].value, PRESS_LINE);
});

Deno.test("a plain-HTTP service is named so, and a replay lane's descriptor names no specific asset id", async () => {
  const lane: Anything = shellDescriptor(await shellOf(site(), 5), "http://api.localhost/functions/v1/aas-api");
  assert.equal(lane.endpoints[0].protocolInformation.endpointProtocol, "HTTP");
  assert.ok(lane.endpoints[0].protocolInformation.href.startsWith("http://api.localhost/functions/v1/aas-api/shells/"), "href");
  assert.ok(!("specificAssetIds" in lane), "a lane names specific asset ids");
  assert.equal(lane.globalAssetId, `https://aber.local/ids/asset/${wire(5)}`);
});

// ---- The listing ---------------------------------------------------------------------------------

Deno.test("the listing describes every shell /shells lists, lanes included and archived devices not", async () => {
  const answer = await get(site(), "/shell-descriptors");
  assert.equal(answer?.status, 200);
  assert.equal(answer?.body.result.map((d: Anything) => d.id), [1, 2, 3, 5, 6].map(shellId));
  assert.equal(answer?.body.paging_metadata, {});
  assert.equal(answer?.body.result[0], shellDescriptor(await shellOf(site(), 1), SERVICE));
});

Deno.test("a cursor walks the listing a page of devices at a time, as /shells does", async () => {
  const walked: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const answer: Anything = await get(site(), "/shell-descriptors", { limit: 2, cursor });
    assert.equal(answer.status, 200);
    walked.push(...answer.body.result.map((d: Anything) => d.id));
    cursor = answer.body.paging_metadata.cursor ?? null;
    pages += 1;
  } while (cursor && pages < 10);
  assert.equal(walked, [1, 2, 3, 5, 6].map(shellId));
  assert.equal(pages, 3);
});

Deno.test("a cursor that names no device is the client's mistake", async () => {
  let thrown: unknown = null;
  try {
    await get(site(), "/shell-descriptors", { cursor: "not-a-device" });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof ClientMistake, `expected a ClientMistake, got ${thrown}`);
});

Deno.test("assetKind and assetType filter the listing, and a value they cannot take is a 400", async () => {
  assert.equal((await get(site(), "/shell-descriptors", { query: "?assetKind=Instance" }))?.body.result.length, 5);
  assert.equal((await get(site(), "/shell-descriptors", { query: "?assetKind=Type" }))?.body.result, []);
  assert.equal(
    (await get(site(), "/shell-descriptors", { query: `?assetType=${b64urlEncode("https://example.test/type")}` }))?.body.result,
    [],
  );
  for (const query of ["?assetKind=Machine", "?assetType=!!!"]) {
    const answer = await get(site(), "/shell-descriptors", { query });
    assert.equal(answer?.status, 400, query);
    assert.equal(answer?.body.messages[0].messageType, "Error", query);
  }
});

// ---- One descriptor ------------------------------------------------------------------------------

Deno.test("one descriptor is found by its shell's exact id, and nothing else finds it", async () => {
  const answer = await get(site(), byId(shellId(1)));
  assert.equal(answer?.status, 200);
  assert.equal(answer?.body, shellDescriptor(await shellOf(site(), 1), SERVICE));

  const submodelOfIt = `https://aber.local/ids/asset/${wire(1)}/submodel/Nameplate`;
  for (const id of [submodelOfIt, shellId(4), shellId(99), "https://elsewhere.test/shell"]) {
    const missing = await get(site(), byId(id));
    assert.equal(missing?.status, 404, id);
    assert.equal(missing?.body.messages[0].text, `No shell descriptor with identifier '${id}'`, id);
  }
  for (const path of ["/shell-descriptors/!!!", "/shell-descriptors/%E0%A4%A"]) {
    assert.equal((await get(site(), path))?.status, 400, path);
  }
  assert.equal((await get(site(), `${byId(shellId(1))}/endpoints`))?.status, 404);
});

Deno.test("a shell's submodel descriptors page by their ids, and one is found by its own", async () => {
  const described: Anything = shellDescriptor(await shellOf(site(), 1), SERVICE);
  const all = described.submodelDescriptors;
  const path = `${byId(shellId(1))}/submodel-descriptors`;

  const whole = await get(site(), path);
  assert.equal(whole?.body, { paging_metadata: {}, result: all });

  const walked: string[] = [];
  let cursor: string | null = null;
  do {
    const answer: Anything = await get(site(), path, { limit: 1, cursor });
    assert.equal(answer.body.result.length, 1);
    walked.push(answer.body.result[0].id);
    cursor = answer.body.paging_metadata.cursor ?? null;
  } while (cursor && walked.length < 10);
  assert.equal(walked, all.map((d: Anything) => d.id));

  assert.equal((await get(site(), path, { cursor: b64urlEncode("https://example.test/none") }))?.status, 400);

  const one = await get(site(), `${path}/${b64urlEncode(all[1].id)}`);
  assert.equal(one?.body, all[1]);
  const other = `https://aber.local/ids/asset/${wire(2)}/submodel/PlatformConnection`;
  assert.equal((await get(site(), `${path}/${b64urlEncode(other)}`))?.status, 404);
  assert.equal((await get(site(), `${path}/!!!`))?.status, 400);
});
