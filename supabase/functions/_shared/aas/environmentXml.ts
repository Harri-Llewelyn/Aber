/**
 * An AAS Environment as XML, in the element order of the IDTA XML schema
 * (`test-harness/schemas/AAS_V3_0_XML_Schema.xsd`, namespace https://admin-shell.io/aas/3/2).
 *
 * The input is the JSON-shaped Environment that `buildEnvironment()` in shell.ts returns, so the
 * two serialisations cannot describe a machine differently. Each shape below lists the keys an
 * object of that kind may carry, in the order the schema's sequence puts them; an object's
 * `modelType` names its element (`Property` is `<property>`), a list is a wrapper element holding
 * one child per item, and a value is the element's text. A key the table does not list is an error,
 * never a silent omission: an Environment that gained a field must gain its place here, and the
 * unit tests build every Environment the exporter makes.
 */

export const AAS_XML_NAMESPACE = "https://admin-shell.io/aas/3/2";

type Obj = Record<string, unknown>;

/** How one key is written: as text, as a nested shape, as a list, or as submodel elements. */
type How =
  | "text"
  | { shape: string }
  | { list: string; of: How }
  | "elements";

type Field = [key: string, how: How];

const REFERENCE: How = { shape: "reference" };
const referenceList: How = { list: "reference", of: REFERENCE };
const langList = (item: string): How => ({ list: item, of: { shape: "langString" } });

/** `Referable`: what every identifiable and every submodel element starts with. */
const REFERABLE: Field[] = [
  ["category", "text"],
  ["idShort", "text"],
  ["displayName", langList("langStringNameType")],
  ["description", langList("langStringTextType")],
];

const IDENTIFIABLE: Field[] = [...REFERABLE, ["administration", { shape: "administrativeInformation" }], ["id", "text"]];

const HAS_SEMANTICS: Field[] = [
  ["semanticId", REFERENCE],
  ["supplementalSemanticIds", referenceList],
];

const HAS_DATA_SPECIFICATION: Field[] = [
  ["embeddedDataSpecifications", { list: "embeddedDataSpecification", of: { shape: "embeddedDataSpecification" } }],
];

/** `SubmodelElement`: referable, semantics, then the data specifications (no qualifiers are made). */
const ELEMENT: Field[] = [...REFERABLE, ...HAS_SEMANTICS, ...HAS_DATA_SPECIFICATION];

const SHAPES: Record<string, Field[]> = {
  environment: [
    ["assetAdministrationShells", { list: "assetAdministrationShell", of: { shape: "assetAdministrationShell" } }],
    ["submodels", { list: "submodel", of: { shape: "submodel" } }],
    ["conceptDescriptions", { list: "conceptDescription", of: { shape: "conceptDescription" } }],
  ],
  reference: [
    ["type", "text"],
    ["referredSemanticId", REFERENCE],
    ["keys", { list: "key", of: { shape: "key" } }],
  ],
  key: [["type", "text"], ["value", "text"]],
  langString: [["language", "text"], ["text", "text"]],
  administrativeInformation: [
    ...HAS_DATA_SPECIFICATION,
    ["version", "text"],
    ["revision", "text"],
    ["creator", REFERENCE],
    ["createdAt", "text"],
    ["updatedAt", "text"],
    ["templateId", "text"],
  ],
  assetAdministrationShell: [
    ...IDENTIFIABLE,
    ...HAS_DATA_SPECIFICATION,
    ["derivedFrom", REFERENCE],
    ["assetInformation", { shape: "assetInformation" }],
    ["submodels", referenceList],
  ],
  assetInformation: [
    ["assetKind", "text"],
    ["globalAssetId", "text"],
    ["specificAssetIds", { list: "specificAssetId", of: { shape: "specificAssetId" } }],
    ["assetType", "text"],
    ["defaultThumbnail", { shape: "resource" }],
  ],
  specificAssetId: [
    ...HAS_SEMANTICS,
    ["name", "text"],
    ["value", "text"],
    ["externalSubjectId", REFERENCE],
  ],
  resource: [["path", "text"], ["contentType", "text"]],
  submodel: [
    ...IDENTIFIABLE,
    ["kind", "text"],
    ...HAS_SEMANTICS,
    ...HAS_DATA_SPECIFICATION,
    ["submodelElements", "elements"],
  ],
  conceptDescription: [
    ...IDENTIFIABLE,
    ...HAS_DATA_SPECIFICATION,
    ["isCaseOf", referenceList],
  ],
  embeddedDataSpecification: [
    ["dataSpecification", REFERENCE],
    // Wrapper only: its one child is named by the content's modelType.
    ["dataSpecificationContent", { shape: "dataSpecificationContent" }],
  ],
  dataSpecificationIec61360: [
    ["preferredName", langList("langStringPreferredNameTypeIec61360")],
    ["shortName", langList("langStringShortNameTypeIec61360")],
    ["unit", "text"],
    ["unitId", REFERENCE],
    ["sourceOfDefinition", "text"],
    ["symbol", "text"],
    ["dataType", "text"],
    ["definition", langList("langStringDefinitionTypeIec61360")],
    ["valueFormat", "text"],
    ["value", "text"],
  ],
};

/** The submodel elements the schema's choice allows, by the JSON `modelType`. */
const ELEMENT_SHAPES: Record<string, Field[]> = {
  Property: [...ELEMENT, ["valueType", "text"], ["value", "text"], ["valueId", REFERENCE]],
  MultiLanguageProperty: [...ELEMENT, ["value", langList("langStringTextType")], ["valueId", REFERENCE]],
  Range: [...ELEMENT, ["valueType", "text"], ["min", "text"], ["max", "text"]],
  ReferenceElement: [...ELEMENT, ["value", REFERENCE]],
  File: [...ELEMENT, ["value", "text"], ["contentType", "text"]],
  Blob: [...ELEMENT, ["value", "text"], ["contentType", "text"]],
  SubmodelElementCollection: [...ELEMENT, ["value", "elements"]],
  SubmodelElementList: [
    ...ELEMENT,
    ["orderRelevant", "text"],
    ["semanticIdListElement", REFERENCE],
    ["typeValueListElement", "text"],
    ["valueTypeListElement", "text"],
    ["value", "elements"],
  ],
};

/** The data specification contents the schema's choice allows, by the JSON `modelType`. */
const CONTENT_SHAPES: Record<string, string> = {
  DataSpecificationIec61360: "dataSpecificationIec61360",
};

const lowerFirst = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/**
 * `text` as XML 1.0 character data. A character the XML 1.0 `Char` production excludes (a control
 * character, a lone surrogate, U+FFFE and U+FFFF) is written as U+FFFD, since no escape can carry it.
 */
export function xmlText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    const valid = code === 0x9 || code === 0xA || code === 0xD || (code >= 0x20 && code <= 0xD7FF) ||
      (code >= 0xE000 && code <= 0xFFFD) || (code >= 0x10000 && code <= 0x10FFFF);
    if (!valid) out += "�";
    else if (char === "&") out += "&amp;";
    else if (char === "<") out += "&lt;";
    else if (char === ">") out += "&gt;";
    else out += char;
  }
  return out;
}

class Writer {
  readonly lines: string[] = [];

  private indent(depth: number) {
    return "  ".repeat(depth);
  }

  /** `<name>text</name>`. A number or a boolean is its string form; anything else is an error. */
  private text(name: string, value: unknown, depth: number, where: string) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`AAS XML: ${where}.${name} is ${typeof value}, not text`);
    }
    this.lines.push(`${this.indent(depth)}<${name}>${xmlText(String(value))}</${name}>`);
  }

  private open(name: string, depth: number, attributes = "") {
    this.lines.push(`${this.indent(depth)}<${name}${attributes}>`);
  }

  private close(name: string, depth: number) {
    this.lines.push(`${this.indent(depth)}</${name}>`);
  }

  /** The children of `object`, as `fields` list them, wherever the object has the key. */
  fields(fields: Field[], object: Obj, depth: number, where: string) {
    const known = new Set(fields.map(([key]) => key));
    for (const key of Object.keys(object)) {
      if (key === "modelType" || object[key] === undefined || object[key] === null) continue;
      if (!known.has(key)) throw new Error(`AAS XML: ${where} has a key "${key}" the XML schema mapping does not list`);
    }
    for (const [key, how] of fields) {
      const value = object[key];
      if (value === undefined || value === null) continue;
      this.field(key, how, value, depth, where);
    }
  }

  private field(name: string, how: How, value: unknown, depth: number, where: string) {
    const here = `${where}.${name}`;
    if (how === "text") return this.text(name, value, depth, where);

    if (how === "elements") {
      const items = this.array(value, here);
      if (items.length === 0) return;
      this.open(name, depth);
      for (const item of items) this.element(item, depth + 1, here);
      this.close(name, depth);
      return;
    }

    if ("shape" in how) {
      const object = this.object(value, here);
      if (how.shape === "dataSpecificationContent") return this.content(name, object, depth, here);
      this.open(name, depth);
      this.fields(this.shape(how.shape), object, depth + 1, here);
      this.close(name, depth);
      return;
    }

    const items = this.array(value, here);
    if (items.length === 0) return;
    this.open(name, depth);
    for (const item of items) this.field(how.list, how.of, item, depth + 1, here);
    this.close(name, depth);
  }

  /** One submodel element, named by its modelType. */
  private element(value: unknown, depth: number, where: string) {
    const object = this.object(value, where);
    const modelType = String(object.modelType ?? "");
    const fields = ELEMENT_SHAPES[modelType];
    if (!fields) throw new Error(`AAS XML: ${where} is a ${modelType || "submodel element with no modelType"}, which the XML schema mapping does not list`);
    const name = lowerFirst(modelType);
    this.open(name, depth);
    this.fields(fields, object, depth + 1, `${where}[${modelType}]`);
    this.close(name, depth);
  }

  /** A data specification's content: `<dataSpecificationContent>` and one child named by its type. */
  private content(name: string, object: Obj, depth: number, where: string) {
    const modelType = String(object.modelType ?? "");
    const shape = CONTENT_SHAPES[modelType];
    if (!shape) throw new Error(`AAS XML: ${where} is a ${modelType || "content with no modelType"}, which the XML schema mapping does not list`);
    this.open(name, depth);
    this.open(lowerFirst(modelType), depth + 1);
    this.fields(this.shape(shape), object, depth + 2, where);
    this.close(lowerFirst(modelType), depth + 1);
    this.close(name, depth);
  }

  private shape(name: string): Field[] {
    const fields = SHAPES[name];
    if (!fields) throw new Error(`AAS XML: no shape ${name}`);
    return fields;
  }

  private object(value: unknown, where: string): Obj {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`AAS XML: ${where} is not an object`);
    }
    return value as Obj;
  }

  private array(value: unknown, where: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`AAS XML: ${where} is not a list`);
    return value;
  }

  root(environment: Obj): string {
    this.open("environment", 0, ` xmlns="${AAS_XML_NAMESPACE}"`);
    this.fields(SHAPES.environment, environment, 1, "environment");
    this.close("environment", 0);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${this.lines.join("\n")}\n`;
  }
}

/** The Environment as an XML document (UTF-8, no byte order mark), ending in a newline. */
export function environmentToXml(environment: Obj): string {
  return new Writer().root(environment);
}
