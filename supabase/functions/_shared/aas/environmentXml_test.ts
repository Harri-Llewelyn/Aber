import { AAS_XML_NAMESPACE, environmentToXml, xmlText } from "./environmentXml.ts";
import { buildEnvironment, type DeviceRecord } from "./shell.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
  throws(fn: () => unknown, needle: string) {
    try {
      fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes(needle)) throw new Error(`expected an error naming ${needle}, got: ${message}`);
      return;
    }
    throw new Error(`expected an error naming ${needle}, and nothing was thrown`);
  },
};

// A reader of the XML schema, small enough to need no dependency. The vendored XSD uses sequences,
// choices, groups, elements, and simple types with enumerations, patterns and lengths, and nothing
// else (no attributes, no extensions), so a content model is matched here by the element names in
// order, and a leaf by its type's restrictions. It checks the writer's output against the real file;
// it is not a validator, and a full one is what the pull request names as missing.

interface Node {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
  text: string;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m]);

/** The text as a tree. No comments, no CDATA, no attributes beyond a plain quoted value. */
function parseXml(source: string): Node {
  const root: Node = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: Node[] = [root];
  const token = /<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  for (const m of source.matchAll(token)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      if (top.name !== m[1]) throw new Error(`</${m[1]}> closes <${top.name}>`);
      stack.pop();
    } else if (m[2] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of m[3].matchAll(/([^\s=]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
      const node: Node = { name: m[2], attrs, children: [], text: "" };
      top.children.push(node);
      if (m[4] !== "/") stack.push(node);
    } else if (m[5] !== undefined) {
      top.text += decode(m[5]);
    }
  }
  if (stack.length !== 1) throw new Error(`<${stack[stack.length - 1].name}> is never closed`);
  return root.children[0];
}

type Particle =
  | { kind: "element"; name: string; type: string | null; inline: Node | null; min: number; max: number }
  | { kind: "sequence" | "choice"; parts: Particle[]; min: number; max: number }
  | { kind: "group"; ref: string; min: number; max: number };

const strip = (name: string) => name.replace(/^xs:/, "");
const occurs = (n: Node): [number, number] => [
  Number(n.attrs.minOccurs ?? 1),
  n.attrs.maxOccurs === "unbounded" ? Infinity : Number(n.attrs.maxOccurs ?? 1),
];

function particleOf(n: Node): Particle {
  const [min, max] = occurs(n);
  switch (strip(n.name)) {
    case "element":
      return {
        kind: "element",
        name: n.attrs.name,
        type: n.attrs.type ?? null,
        inline: n.children.find((c) => strip(c.name) === "complexType" || strip(c.name) === "simpleType") ?? null,
        min,
        max,
      };
    case "sequence":
    case "choice":
      return { kind: strip(n.name) as "sequence" | "choice", parts: n.children.map(particleOf), min, max };
    case "group":
      return { kind: "group", ref: n.attrs.ref, min, max };
    default:
      throw new Error(`the XSD has a ${n.name} where a particle is expected`);
  }
}

class Xsd {
  readonly complex = new Map<string, Particle>();
  readonly groups = new Map<string, Particle>();
  readonly simple = new Map<string, Node>();

  constructor(source: string) {
    const schema = parseXml(source);
    for (const child of schema.children) {
      const kind = strip(child.name);
      if (kind === "complexType") this.complex.set(child.attrs.name, this.body(child));
      else if (kind === "group") this.groups.set(child.attrs.name, this.body(child));
      else if (kind === "simpleType") this.simple.set(child.attrs.name, child);
    }
  }

  /** The one sequence, choice or group a complexType or group holds. */
  private body(n: Node): Particle {
    const first = n.children.find((c) => ["sequence", "choice", "group"].includes(strip(c.name)));
    if (!first) throw new Error(`${n.attrs.name} has no content model`);
    return particleOf(first);
  }

  /** Every position `p` can leave the cursor at, reading `kids` from `pos`, once. */
  private once(p: Particle, kids: Node[], pos: number): Set<number> {
    if (p.kind === "element") return kids[pos]?.name === p.name ? new Set([pos + 1]) : new Set();
    if (p.kind === "group") return this.times(this.groups.get(p.ref) as Particle, kids, pos);
    if (p.kind === "choice") {
      const out = new Set<number>();
      for (const part of p.parts) for (const e of this.times(part, kids, pos)) out.add(e);
      return out;
    }
    let at = new Set([pos]);
    for (const part of p.parts) {
      const next = new Set<number>();
      for (const s of at) for (const e of this.times(part, kids, s)) next.add(e);
      at = next;
    }
    return at;
  }

  private times(p: Particle, kids: Node[], pos: number): Set<number> {
    const done = new Set<number>();
    if (p.min === 0) done.add(pos);
    let at = new Set([pos]);
    for (let n = 1; n <= p.max && n <= kids.length + 1; n++) {
      const next = new Set<number>();
      for (const s of at) for (const e of this.once(p, kids, s)) next.add(e);
      if (next.size === 0) break;
      if (n >= p.min) for (const e of next) done.add(e);
      if ([...next].every((e) => at.has(e))) break;
      at = next;
    }
    return done;
  }

  /** The complaints about `node` and below, each with the path to it. */
  check(node: Node, particle: Particle, path: string, problems: string[]) {
    if (particle.kind !== "element") throw new Error("check starts at an element");
    const here = `${path}/${node.name}`;
    const inline = particle.inline;
    const typeName = particle.type;
    if (typeName && this.complex.has(typeName)) {
      this.content(node, this.complex.get(typeName) as Particle, here, problems);
    } else if (inline && strip(inline.name) === "complexType") {
      this.content(node, this.body(inline), here, problems);
    } else {
      if (node.children.length > 0) problems.push(`${here} has children but is text`);
      this.text(node.text, typeName ? this.simple.get(typeName) ?? null : inline, typeName, here, problems);
    }
  }

  private content(node: Node, model: Particle, here: string, problems: string[]) {
    if (node.text.trim() !== "") problems.push(`${here} has text beside its children`);
    const ends = this.times({ ...model, min: 1, max: 1 } as Particle, node.children, 0);
    if (!ends.has(node.children.length)) {
      problems.push(`${here} has children ${node.children.map((c) => c.name).join(",")} that no sequence of its type allows`);
      return;
    }
    const known = this.elementsOf(model, new Map());
    for (const child of node.children) {
      const particle = known.get(child.name);
      if (!particle) problems.push(`${here} has an element ${child.name} its type does not name`);
      else this.check(child, particle, here, problems);
    }
  }

  /** The element particles a model can place, by name. */
  private elementsOf(p: Particle, into: Map<string, Particle>): Map<string, Particle> {
    if (p.kind === "element") into.set(p.name, p);
    else if (p.kind === "group") this.elementsOf(this.groups.get(p.ref) as Particle, into);
    else for (const part of p.parts) this.elementsOf(part, into);
    return into;
  }

  private text(text: string, type: Node | null, typeName: string | null, here: string, problems: string[]) {
    if (!type) {
      if (typeName && !typeName.startsWith("xs:")) problems.push(`${here} names the type ${typeName}, which the XSD does not define`);
      return;
    }
    const restriction = type.children.find((c) => strip(c.name) === "restriction") ?? type.children.find((c) => strip(c.name) === "simpleType")?.children[0];
    if (!restriction) return;
    const enums = restriction.children.filter((c) => strip(c.name) === "enumeration").map((c) => c.attrs.value);
    if (enums.length > 0 && !enums.includes(text)) problems.push(`${here} is "${text}", not one of ${enums.join(", ")}`);
    for (const c of restriction.children) {
      const kind = strip(c.name);
      if (kind === "minLength" && text.length < Number(c.attrs.value)) problems.push(`${here} is shorter than ${c.attrs.value}`);
      if (kind === "maxLength" && text.length > Number(c.attrs.value)) problems.push(`${here} is longer than ${c.attrs.value}`);
      if (kind === "pattern" && !new RegExp(`^(?:${c.attrs.value})$`, "u").test(text)) problems.push(`${here} ("${text.slice(0, 40)}") does not match ${c.attrs.value.slice(0, 60)}`);
    }
  }

  /** The complaints about a whole document whose root is the global element `name`. */
  validate(document: Node): string[] {
    const problems: string[] = [];
    // The XSD's one global element: <xs:element name="environment" type="environment_t"/>.
    const root: Particle = { kind: "element", name: "environment", type: "environment_t", inline: null, min: 1, max: 1 };
    if (document.name !== root.name) return [`the root is <${document.name}>, not <environment>`];
    this.check(document, root, "", problems);
    return problems;
  }
}

const XSD_URL = new URL("../../../../test-harness/schemas/AAS_V3_0_XML_Schema.xsd", import.meta.url);
const xsd = new Xsd(await Deno.readTextFile(XSD_URL));

function problemsOf(environment: Record<string, unknown>): string[] {
  const xml = environmentToXml(environment);
  return xsd.validate(parseXml(xml));
}

// ---- fixtures ----------------------------------------------------------------------------------

const MTC = "https://aber.local/semantics/mtconnect/v2.0/DataItemType/";
const metric = (name: string, semanticId: string | null, extra: Record<string, unknown> = {}) => ({
  name,
  semantic_id: semanticId,
  datatype: 10,
  units: "CELSIUS",
  description: `The ${name} reading`,
  standard: "MTConnect",
  deprecated: false,
  ...extra,
});

/** A device that exercises every element the exporter makes: nameplate, telemetry, KPIs, derived, a model. */
function fullRecord(): DeviceRecord {
  return {
    device: { id: "d1", sparkplug_id: "dev1", name: "Mill 1", model_3d_path: "mills/mill.glb", last_birth_metrics: ["Controller/PART_COUNT"] },
    config: [
      { metric_name: "SERIAL_NUMBER", val_string: "SN-1" },
      { metric_name: "Systems/TEMPERATURE", val_double: 41.5 },
    ],
    links: [{ schema_id: "s1", submodel_key: null }],
    catalog: [
      metric("Systems/TEMPERATURE", MTC + "TEMPERATURE"),
      metric("OEE/AVAILABILITY", "https://aber.local/semantics/iso22400/AVAILABILITY", { standard: "ISO 22400", units: null, datatype: 10 }),
      metric("Controller/PART_COUNT", null, { datatype: 8, units: null, standard: null, description: 'A <count> & "more"' }),
      {
        name: "Controller/PARTS_PER_HOUR",
        semantic_id: null,
        datatype: 10,
        derivation: { kind: "counter_rate", input: "Controller/PART_COUNT" },
        standard: null,
        deprecated: false,
      },
    ],
    gateway: { name: "Cell gateway", sparkplug_id: "gwy1" },
    nameplate: { manufacturer_name: "Acme & Sons", serial_number: "SN-1" },
    templates: [{ id_short: "ManufacturerName", semantic_id: "0112/2///61987#ABA565#009", description: "Legal name of the manufacturer." }],
    schemas: [{
      id: "s1",
      schema_name: "Mill_Schema",
      semantic_id: "https://example.org/submodels/Mill/1/0",
      schema_definition: { properties: { "Systems/TEMPERATURE": {}, "OEE/AVAILABILITY": {}, "Controller/PART_COUNT": {} } },
    }],
    definitions: [{
      semantic_id: MTC + "TEMPERATURE",
      name: "TEMPERATURE",
      definition: "The temperature of a part of the equipment.",
      standard: "MTConnect",
    }],
  };
}

// ---- the writer --------------------------------------------------------------------------------

Deno.test("a small environment is written in the schema's order, in its namespace", () => {
  const xml = environmentToXml({
    assetAdministrationShells: [{
      modelType: "AssetAdministrationShell",
      id: "urn:shell",
      idShort: "Arm",
      assetInformation: { assetKind: "Instance", globalAssetId: "urn:asset" },
      submodels: [{ type: "ModelReference", keys: [{ type: "Submodel", value: "urn:sm" }] }],
    }],
    submodels: [{
      modelType: "Submodel",
      id: "urn:sm",
      idShort: "Telemetry",
      kind: "Instance",
      semanticId: { type: "ExternalReference", keys: [{ type: "GlobalReference", value: "urn:concept" }] },
      submodelElements: [{
        modelType: "Property",
        idShort: "Temp",
        valueType: "xs:double",
        value: "42.5",
        description: [{ language: "en", text: "Temperature" }],
      }],
    }],
  });
  assert.equal(
    xml,
    `<?xml version="1.0" encoding="UTF-8"?>
<environment xmlns="${AAS_XML_NAMESPACE}">
  <assetAdministrationShells>
    <assetAdministrationShell>
      <idShort>Arm</idShort>
      <id>urn:shell</id>
      <assetInformation>
        <assetKind>Instance</assetKind>
        <globalAssetId>urn:asset</globalAssetId>
      </assetInformation>
      <submodels>
        <reference>
          <type>ModelReference</type>
          <keys>
            <key>
              <type>Submodel</type>
              <value>urn:sm</value>
            </key>
          </keys>
        </reference>
      </submodels>
    </assetAdministrationShell>
  </assetAdministrationShells>
  <submodels>
    <submodel>
      <idShort>Telemetry</idShort>
      <id>urn:sm</id>
      <kind>Instance</kind>
      <semanticId>
        <type>ExternalReference</type>
        <keys>
          <key>
            <type>GlobalReference</type>
            <value>urn:concept</value>
          </key>
        </keys>
      </semanticId>
      <submodelElements>
        <property>
          <idShort>Temp</idShort>
          <description>
            <langStringTextType>
              <language>en</language>
              <text>Temperature</text>
            </langStringTextType>
          </description>
          <valueType>xs:double</valueType>
          <value>42.5</value>
        </property>
      </submodelElements>
    </submodel>
  </submodels>
</environment>
`,
  );
});

Deno.test("text is escaped, and a character XML 1.0 cannot carry is replaced", () => {
  assert.equal(xmlText('a < b & c > "d"'), 'a &lt; b &amp; c &gt; "d"');
  assert.equal(xmlText("tab\tnew\nline"), "tab\tnew\nline");
  assert.equal(xmlText("bell\u0007 nul\u0000 end"), "bell� nul� end");
  assert.equal(xmlText("\uD800"), "�");
  assert.equal(xmlText("emoji \u{1F600}"), "emoji \u{1F600}");
  assert.equal(xmlText("￾￿"), "��");
});

Deno.test("an unset value is left out, and so is an empty list", () => {
  const xml = environmentToXml({
    submodels: [{
      modelType: "Submodel",
      id: "urn:sm",
      kind: "Instance",
      semanticId: undefined,
      description: [],
      submodelElements: [{ modelType: "Property", idShort: "Temp", valueType: "xs:double", value: undefined }],
    }],
  });
  assert.equal(xml.includes("<semanticId>"), false);
  assert.equal(xml.includes("<description>"), false);
  assert.equal(xml.includes("<value>"), false);
  assert.equal(xml.includes("<valueType>xs:double</valueType>"), true);
});

Deno.test("a key the mapping does not list is an error, never a silent omission", () => {
  assert.throws(
    () => environmentToXml({ submodels: [{ modelType: "Submodel", id: "urn:sm", qualifiers: [{}] }] }),
    'a key "qualifiers"',
  );
  assert.throws(
    () => environmentToXml({ submodels: [{ modelType: "Submodel", id: "urn:sm", surprise: 1 }] }),
    'a key "surprise"',
  );
  assert.throws(
    () => environmentToXml({ submodels: [{ modelType: "Submodel", id: "urn:sm", submodelElements: [{ modelType: "Operation" }] }] }),
    "Operation",
  );
  assert.throws(
    () => environmentToXml({ submodels: [{ modelType: "Submodel", id: "urn:sm", submodelElements: [{ idShort: "x" }] }] }),
    "no modelType",
  );
  assert.throws(() => environmentToXml({ submodels: "not a list" }), "not a list");
});

// ---- against the vendored XSD ------------------------------------------------------------------

Deno.test("the reader of the XSD finds faults a writer could make", () => {
  const good = { submodels: [{ modelType: "Submodel", id: "urn:sm", kind: "Instance" }] };
  assert.equal(problemsOf(good), []);
  // An element out of order, an enumerated value that is not one, and a missing required child.
  const swapped = `<environment xmlns="${AAS_XML_NAMESPACE}"><submodels><submodel><kind>Instance</kind><id>urn:sm</id></submodel></submodels></environment>`;
  assert.equal(xsd.validate(parseXml(swapped)).length > 0, true, "an id after kind is out of order");
  const badKind = `<environment xmlns="${AAS_XML_NAMESPACE}"><submodels><submodel><id>urn:sm</id><kind>Sometimes</kind></submodel></submodels></environment>`;
  assert.equal(xsd.validate(parseXml(badKind)).some((p) => p.includes("not one of")), true);
  const noId = `<environment xmlns="${AAS_XML_NAMESPACE}"><submodels><submodel><kind>Instance</kind></submodel></submodels></environment>`;
  assert.equal(xsd.validate(parseXml(noId)).length > 0, true, "a submodel needs its id");
});

Deno.test("an Environment the exporter builds follows the XSD's elements, order, values and patterns", () => {
  const built = buildEnvironment(fullRecord());
  assert.equal(problemsOf(built.environment), []);
  // It had every kind of element the exporter makes, so the check above covered them.
  const xml = environmentToXml(built.environment);
  for (const element of ["<property>", "<submodelElementCollection>", "<file>", "<conceptDescription>", "<dataSpecificationIec61360>", "<assetInformation>"]) {
    assert.equal(xml.includes(element), true, `the document has no ${element}`);
  }
  // Carried as data, not as markup.
  assert.equal(xml.includes("Acme &amp; Sons"), true);
  assert.equal(xml.includes("A &lt;count&gt; &amp; \"more\""), true);
});

Deno.test("the XML and the JSON say the same thing: every id, idShort and value in one is in the other", () => {
  const { environment } = buildEnvironment(fullRecord());
  const tree = parseXml(environmentToXml(environment));
  const texts = (n: Node, name: string): string[] =>
    [...(n.name === name ? [n.text] : []), ...n.children.flatMap((c) => texts(c, name))];
  const walk = (value: unknown, key: string, out: string[]) => {
    if (Array.isArray(value)) for (const v of value) walk(v, key, out);
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (k === key && typeof v === "string") out.push(v);
        else walk(v, key, out);
      }
    }
  };
  for (const key of ["id", "idShort", "valueType", "value", "globalAssetId"]) {
    const fromJson: string[] = [];
    walk(environment, key, fromJson);
    // A <value> that wraps a collection's elements has no text of its own.
    assert.equal(texts(tree, key).filter((t) => t.trim() !== "").sort(), fromJson.sort(), `the ${key} values`);
  }
});

Deno.test("the package-level facts: a namespace, one root, UTF-8, a trailing newline", () => {
  const xml = environmentToXml(buildEnvironment(fullRecord()).environment);
  assert.equal(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<environment xmlns="https://admin-shell.io/aas/3/2">\n'), true);
  assert.equal(xml.endsWith("</environment>\n"), true);
  assert.equal(parseXml(xml).name, "environment");
  assert.equal(xml.includes("\u0000"), false);
});
