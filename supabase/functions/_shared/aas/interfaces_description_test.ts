import {
  buildEnvironment,
  buildInterfacesDescription,
  type DeviceRecord,
  INTERFACES_TEMPLATE_ID,
  type LiveInterfaces,
  loadLiveInterfaces,
  referencedSemanticIds,
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

const COLUMNS = [
  "path", "parent_path", "ordinal", "id_short", "model_type", "value_type", "semantic_id", "semantic_id_type",
  "supplemental_semantic_ids", "cardinality", "definition", "example_value",
] as const;

/** The Asset Interfaces Description's rows, read from the block 0320 seeds them with. */
function seededRows(): TemplateElement[] {
  const sql = Deno.readTextFileSync(new URL(
    "../../../migrations/0320_an_idta_template_is_seeded_with_its_nested_elements.sql",
    import.meta.url,
  ));
  const block = sql.slice(sql.indexOf(`SELECT '${INTERFACES_TEMPLATE_ID}'`));
  const token = /ARRAY\[([^\]]*)\]::text\[\]|'((?:[^']|'')*)'|NULL|\d+/g;
  const text = (value: string) => value.replaceAll("''", "'");
  return block.slice(0, block.indexOf("\n  ) AS e (")).split("\n").filter((line) => line.startsWith("('"))
    .map((line) => {
      const values = [...line.matchAll(token)].map((m) =>
        m[1] !== undefined
          ? [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((s) => text(s[1]))
          : m[2] !== undefined
          ? text(m[2])
          : m[0] === "NULL"
          ? null
          : Number(m[0])
      );
      const row = Object.fromEntries(COLUMNS.map((column, i) => [column, values[i]]));
      return {
        ...row,
        template_id: INTERFACES_TEMPLATE_ID,
        template_name: "Asset Interfaces Description",
        template_number: "IDTA 02017",
      } as unknown as TemplateElement;
    });
}

const ROWS = seededRows();
const ORIGIN = "https://i3x.plant.example";
const BROKER = "mqtts://mqtt.plant.example:8883";
const TOPIC = "uns/Acme/Works/Press Hall/Cell 1/Press 1";
const DEVICE = { id: "d1", sparkplug_id: "dev0123456789abcdef01234", name: "Press 1" };
const METRICS = [
  { name: "Controller/EXECUTION", datatype: 12 },
  { name: "PART_COUNT", datatype: 4 },
  { name: "Spindle+Speed", datatype: 10 },
];
const ID = "https://aber.local/ids/asset/dev0123456789abcdef01234/submodel/AssetInterfacesDescription";

const live = (extra: Partial<LiveInterfaces> = {}): LiveInterfaces => ({
  elements: ROWS,
  i3x: { origin: ORIGIN },
  uns: { broker: BROKER, topic: TOPIC },
  ...extra,
});

/** The element at a dotted idShort path, as aas-api walks one. */
function at(node: Anything, path: string): Anything {
  let found: Anything = node;
  for (const idShort of path.split(".")) {
    const pool = found.submodelElements ?? found.value ?? [];
    found = pool.find((e: Anything) => e.idShort === idShort);
    if (!found) throw new Error(`no element at ${path} (stopped at ${idShort})`);
  }
  return found;
}

const valueAt = (node: Anything, path: string) => at(node, path).value;
const idOf = (element: Anything) => element.semanticId?.keys?.[0]?.value;
const rowAt = (path: string) => ROWS.find((r) => r.path === path)!;

Deno.test("the seeded block is read: 360 rows under three interface templates", () => {
  assert.equal(ROWS.length, 360);
  assert.equal(ROWS.filter((r) => r.parent_path === null).map((r) => r.path), [
    "InterfaceTemplateForHTTP",
    "InterfaceTemplateForMODBUS",
    "InterfaceTemplateForMQTT",
  ]);
});

Deno.test("i3X is an HTTP interface: its origin, a bearer token, and the device and each metric by its elementId", () => {
  const aid = buildInterfacesDescription(ID, DEVICE, METRICS, live())!;
  assert.equal(idOf(aid), INTERFACES_TEMPLATE_ID);
  const i3x = at(aid, "I3X");
  assert.equal(idOf(i3x), rowAt("InterfaceTemplateForHTTP").semantic_id);
  assert.equal(
    i3x.supplementalSemanticIds.map((r: Anything) => r.keys[0].value),
    ["http://www.w3.org/2011/http", "https://www.w3.org/2019/wot/td"],
  );
  assert.equal(valueAt(i3x, "title"), "i3X");
  assert.equal(valueAt(i3x, "EndpointMetadata.base"), ORIGIN);
  assert.equal(valueAt(i3x, "EndpointMetadata.contentType"), "application/json");
  const scheme = at(i3x, "EndpointMetadata.securityDefinitions.bearer_sc");
  assert.equal(
    scheme.value.map((p: Anything) => [p.idShort, p.value]),
    [["scheme", "bearer"], ["in", "header"], ["name", "Authorization"]],
  );

  const properties = at(i3x, "InteractionMetadata.properties").value;
  assert.equal(properties.map((p: Anything) => [p.idShort, valueAt(p, "key"), p.value.find((e: Anything) => e.idShort === "type")?.value]), [
    ["Press_1", DEVICE.sparkplug_id, "object"],
    ["Controller_EXECUTION", `${DEVICE.sparkplug_id}/Controller/EXECUTION`, "string"],
    ["PART_COUNT", `${DEVICE.sparkplug_id}/PART_COUNT`, "integer"],
    ["Spindle_Speed", `${DEVICE.sparkplug_id}/Spindle+Speed`, "number"],
  ]);
  for (const p of properties) {
    assert.equal(valueAt(p, "observable"), "true", p.idShort);
    assert.equal(valueAt(p, "forms.href"), "/v1/objects/value", p.idShort);
    assert.equal(valueAt(p, "forms.htv_methodName"), "POST", p.idShort);
  }
});

Deno.test("the UNS bridge is an MQTT interface: the broker, and each published metric by its topic", () => {
  const aid = buildInterfacesDescription(ID, DEVICE, METRICS, live())!;
  const uns = at(aid, "UnifiedNamespace");
  assert.equal(
    uns.supplementalSemanticIds.map((r: Anything) => r.keys[0].value),
    ["http://www.w3.org/2011/mqtt", "https://www.w3.org/2019/wot/td"],
  );
  assert.equal(valueAt(uns, "EndpointMetadata.base"), BROKER);
  assert.equal(valueAt(uns, "EndpointMetadata.contentType"), "application/json");
  assert.equal(at(uns, "EndpointMetadata.securityDefinitions.basic_sc").value.map((p: Anything) => [p.idShort, p.value]), [
    ["scheme", "basic"],
  ]);
  // A name with + or # is never published by the bridge, so it has no topic here.
  const properties = at(uns, "InteractionMetadata.properties").value;
  assert.equal(properties.map((p: Anything) => [p.idShort, valueAt(p, "key"), valueAt(p, "forms.href")]), [
    ["Controller_EXECUTION", "Controller/EXECUTION", "/uns/Acme/Works/Press%20Hall/Cell%201/Press%201/Controller/EXECUTION"],
    ["PART_COUNT", "PART_COUNT", "/uns/Acme/Works/Press%20Hall/Cell%201/Press%201/PART_COUNT"],
  ]);
  for (const p of properties) {
    assert.equal(valueAt(p, "type"), "object", p.idShort);
    assert.equal(
      ["mqv_controlPacket", "mqv_retain", "mqv_qos"].map((name) => valueAt(p, `forms.${name}`)),
      ["subscribe", "true", "0"],
    );
  }
});

Deno.test("every security list points at its interface's one scheme, by model reference", () => {
  const aid = buildInterfacesDescription(ID, DEVICE, METRICS, live())!;
  for (const [idShort, scheme] of [["I3X", "bearer_sc"], ["UnifiedNamespace", "basic_sc"]]) {
    const lists: Anything[] = [at(aid, `${idShort}.EndpointMetadata.security`)];
    for (const p of at(aid, `${idShort}.InteractionMetadata.properties`).value) lists.push(at(p, "forms.security"));
    for (const list of lists) {
      assert.equal(list.modelType, "SubmodelElementList");
      assert.equal(list.typeValueListElement, "ReferenceElement");
      assert.equal(list.value.map((r: Anything) => r.value.keys.map((k: Anything) => k.value)), [
        [ID, idShort, "EndpointMetadata", "securityDefinitions", scheme],
      ]);
      // A ReferenceElement's target is resolvable in this very submodel.
      at(aid, list.value[0].value.keys.slice(1).map((k: Anything) => k.value).join("."));
    }
  }
});

Deno.test("each element's ids come from the template's rows, not from the code", () => {
  const moved = ROWS.map((r) =>
    r.path === "InterfaceTemplateForMQTT.EndpointMetadata.base" ? { ...r, semantic_id: "urn:example:moved" } : r
  );
  const aid = buildInterfacesDescription(ID, DEVICE, METRICS, live({ elements: moved }))!;
  assert.equal(idOf(at(aid, "UnifiedNamespace.EndpointMetadata.base")), "urn:example:moved");
  assert.equal(idOf(at(aid, "I3X.EndpointMetadata.base")), rowAt("InterfaceTemplateForHTTP.EndpointMetadata.base").semantic_id);
  const key = at(aid, "I3X.InteractionMetadata.properties.PART_COUNT.key");
  const row = rowAt("InterfaceTemplateForHTTP.InteractionMetadata.properties.property_name.key");
  assert.equal([idOf(key), key.supplementalSemanticIds.map((r: Anything) => r.keys[0].value), key.valueType], [
    row.semantic_id,
    row.supplemental_semantic_ids,
    row.value_type,
  ]);
});

Deno.test("it is omitted, not emitted empty", () => {
  assert.equal(buildInterfacesDescription(ID, DEVICE, METRICS, live({ i3x: undefined, uns: undefined })), undefined);
  // The bridge publishes none of a device with no modelled metric, and i3X is off.
  assert.equal(buildInterfacesDescription(ID, DEVICE, [], live({ i3x: undefined })), undefined);
  // Without the template's rows nothing can carry their ids.
  assert.equal(buildInterfacesDescription(ID, DEVICE, METRICS, live({ elements: [] })), undefined);
  const partial = ROWS.filter((r) => r.path !== "InterfaceTemplateForHTTP.EndpointMetadata.securityDefinitions.bearer_sc.name");
  assert.equal(buildInterfacesDescription(ID, DEVICE, METRICS, live({ elements: partial })), undefined);
});

Deno.test("each surface is there only while it is on", () => {
  const i3xOnly: Anything = buildInterfacesDescription(ID, DEVICE, METRICS, live({ uns: undefined }));
  assert.equal(i3xOnly.submodelElements.map((e: Anything) => e.idShort), ["I3X"]);
  const unsOnly: Anything = buildInterfacesDescription(ID, DEVICE, METRICS, live({ i3x: undefined }));
  assert.equal(unsOnly.submodelElements.map((e: Anything) => e.idShort), ["UnifiedNamespace"]);
  // A device with no schema is still an i3X object, whose map holds what its birth declared.
  const bare: Anything = buildInterfacesDescription(ID, DEVICE, [], live());
  assert.equal(bare.submodelElements.map((e: Anything) => e.idShort), ["I3X"]);
});

Deno.test("two names that clean to one idShort stay apart, and the device's name takes none of theirs", () => {
  const aid = buildInterfacesDescription(ID, { ...DEVICE, name: "A B" }, [{ name: "A/B" }, { name: "A_B" }], live())!;
  assert.equal(at(aid, "I3X.InteractionMetadata.properties").value.map((p: Anything) => p.idShort), ["A_B_3", "A_B", "A_B_2"]);
  assert.equal(at(aid, "UnifiedNamespace.InteractionMetadata.properties").value.map((p: Anything) => p.idShort), ["A_B", "A_B_2"]);
});

Deno.test("it names no credential: every value is an address, an id, a word of the schema or a flag", () => {
  const aid = buildInterfacesDescription(ID, DEVICE, METRICS, live())!;
  const values: string[] = [];
  const walk = (node: Anything) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node?.modelType === "Property") values.push(node.value);
    if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(aid);
  const allowed = new Set([
    "i3X", "Unified Namespace", ORIGIN, BROKER, "application/json", "bearer", "header", "Authorization", "basic",
    "object", "string", "integer", "number", "true", "/v1/objects/value", "POST", "subscribe", "0",
    DEVICE.sparkplug_id, ...METRICS.map((m) => m.name),
  ]);
  const unexpected = values.filter((v) => !allowed.has(v) && !v.startsWith(`${DEVICE.sparkplug_id}/`) && !v.startsWith("/uns/"));
  assert.equal(unexpected, []);
});

const record = (extra: Partial<DeviceRecord> = {}): DeviceRecord => ({
  device: DEVICE,
  config: [],
  links: [{ schema_id: "s1", submodel_key: null }],
  catalog: METRICS.map((m) => ({ id: m.name, name: m.name, datatype: m.datatype, semantic_id: null })),
  gateway: null,
  nameplate: null,
  templates: [],
  schemas: [{ id: "s1", schema_name: "Press", schema_definition: { properties: { "PART_COUNT": {} }, required: ["Controller/EXECUTION"] } }],
  definitions: [],
  ...extra,
});

Deno.test("a shell carries it only where its record was loaded with the live interfaces", () => {
  const exported = buildEnvironment(record());
  assert.equal(exported.submodels.some((s) => s.idShort === "AssetInterfacesDescription"), false);

  const served = buildEnvironment(record({ interfaces: live() }));
  const aid = served.submodels.find((s) => s.idShort === "AssetInterfacesDescription")!;
  assert.equal(aid.id, ID);
  assert.equal((served.shell.submodels as Anything[]).at(-1).keys[0].value, ID);
  // The schema's modelled metrics, in name order, each with its catalog datatype.
  assert.equal(at(aid, "I3X.InteractionMetadata.properties").value.map((p: Anything) => valueAt(p, "key")), [
    DEVICE.sparkplug_id,
    `${DEVICE.sparkplug_id}/Controller/EXECUTION`,
    `${DEVICE.sparkplug_id}/PART_COUNT`,
  ]);
  // Every id it references has a ConceptDescription, which names the template its element is from.
  const described = new Set((served.environment.conceptDescriptions as Anything[]).map((cd) => cd.id));
  for (const id of referencedSemanticIds([aid])) assert.equal(described.has(id), true, id);
  const titleCd = (served.environment.conceptDescriptions as Anything[]).find((cd) =>
    cd.id === rowAt("InterfaceTemplateForHTTP.EndpointMetadata.base").semantic_id
  );
  assert.equal(
    titleCd.embeddedDataSpecifications[0].dataSpecificationContent.definition[0].text,
    "The IDTA 02017 Asset Interfaces Description element base.",
  );
});

/** A client over one table each, filtered as PostgREST filters, that records which tables were read. */
function client(tables: Record<string, Record<string, unknown>[]>, read: string[] = []) {
  return {
    from(table: string) {
      read.push(table);
      const filters: [string, unknown][] = [];
      const rows = () => (tables[table] ?? []).filter((row) => filters.every(([column, value]) => row[column] === value));
      const builder = Object.assign(Promise.resolve().then(() => ({ data: rows(), error: null })), {
        select: () => builder,
        eq: (column: string, value: unknown) => (filters.push([column, value]), builder),
        // deno-lint-ignore no-explicit-any
      }) as any;
      return builder;
    },
  };
}

const TABLES = {
  idta_template_elements: ROWS as unknown as Record<string, unknown>[],
  device_uns_paths: [
    { device_id: "d1", uns_path: "Acme/Works/Press Hall/Cell 1/Press 1", skip_reason: null },
    { device_id: "d2", uns_path: null, skip_reason: "unassigned" },
  ],
};

Deno.test("the loader puts the device's topic under the bridge's root, as the bridge and the dashboard do", async () => {
  const loaded = await loadLiveInterfaces(client(TABLES), DEVICE, { unsBroker: BROKER, unsTopicRoot: "plant/uns", i3x: ORIGIN });
  assert.equal([loaded!.elements.length, loaded!.uns, loaded!.i3x], [
    360,
    { broker: BROKER, topic: "plant/uns/Acme/Works/Press Hall/Cell 1/Press 1" },
    { origin: ORIGIN },
  ]);
  // A device the bridge skips has no topic, so no UNS entry.
  const skipped = await loadLiveInterfaces(client(TABLES), { id: "d2" }, { unsBroker: BROKER, unsTopicRoot: "uns", i3x: "" });
  assert.equal([skipped!.uns, skipped!.i3x], [undefined, undefined]);
});

Deno.test("a worker with no live endpoint reads nothing for them", async () => {
  const read: string[] = [];
  assert.equal(await loadLiveInterfaces(client(TABLES, read), DEVICE, { unsBroker: "", unsTopicRoot: "uns", i3x: "" }), undefined);
  assert.equal(read, []);
  // With i3X alone, the view of UNS paths is not read either.
  await loadLiveInterfaces(client(TABLES, read), DEVICE, { unsBroker: "", unsTopicRoot: "uns", i3x: ORIGIN });
  assert.equal(read, ["idta_template_elements"]);
});
