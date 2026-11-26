/**
 * The AAS mapping layer: rows in this database to an AAS V3 Environment, built once here and
 * presented by `aas-export` (a serialised file) and `aas-api` (the IDTA-01002 REST surface, AAS
 * Part 2). The client is an argument: aas-export passes a service-role client, aas-api the
 * caller's own, so RLS applies to the live API. Every table read below carries `SELECT TO
 * authenticated USING (true)`, so every signed-in caller reads the same shell; if that stops being
 * true for one, the API's answer changes shape without erroring. AASX packaging stays in aas-export.
 */
import { sparkplugToXsd } from "./sparkplugToXsd.ts";
import { QUDT_UNIT_IDS } from "./qudtUnits.ts";
import { modelContentType, modelFileName } from "./model3dContentType.ts";
import { assignSubmodelKeys } from "./submodelKeys.ts";

// Configuration, read at module load and so per worker: main/index.ts spawns one worker per
// function with only the variables its registry entry names, so both aas-export and aas-api must
// declare the AAS_* set.

/** Namespace for asset and submodel ids. Configurable because an IRI must be resolvable for the
 *  organisation publishing it, and `aber.local` is only right for this stack. */
export const BASE_IRI = (Deno.env.get("AAS_BASE_IRI") ?? "https://aber.local/ids/asset/")
  .replace(/\/+$/, "") + "/";

/**
 * A device's globalAssetId: the base IRI, its trailing `/`s made one, then the device's sparkplug_id.
 * The i3X server names it in each device's `metadata.system` (aas_global_asset_id() in
 * i3x/address_space.py); test-harness/fixtures/asset-identities.json holds the two to one answer.
 */
export function globalAssetIdOf(sparkplugId: string, baseIri: string = BASE_IRI): string {
  return `${baseIri.replace(/\/+$/, "")}/${sparkplugId}`;
}

/** The id of a device's shell: its globalAssetId, then `/shell`. */
export function shellIdOf(sparkplugId: string, baseIri: string = BASE_IRI): string {
  return `${globalAssetIdOf(sparkplugId, baseIri)}/shell`;
}

/** Where a consumer fetches the actual samples. The shell points at this; it never embeds them. */
export const HISTORIAN_ENDPOINT =
  Deno.env.get("AAS_HISTORIAN_ENDPOINT") ?? "http://localhost:54321/rest/v1/telemetry";

/**
 * The i3X server's history route, where a second LinkedSegment points: blank while the chart
 * publishes no i3X server, and then the segment is left out.
 */
export const I3X_HISTORY_ENDPOINT = (Deno.env.get("AAS_I3X_HISTORY_ENDPOINT") ?? "").trim();

/**
 * Public base for 3D model objects. `devices.model_3d_path` stores an object key, so the absolute
 * URL is composed here. It cannot be derived from SUPABASE_URL, which names an in-cluster Service
 * that resolves for nothing outside the cluster, so it defaults to the published gateway address
 * and is overridden per deployment, like AAS_BASE_IRI.
 */
export const MODEL_PUBLIC_BASE = (
  Deno.env.get("AAS_MODEL_PUBLIC_BASE") ??
    "http://localhost:54321/storage/v1/object/public/asset-3d-models"
).replace(/\/+$/, "");

/** The bucket 3D models live in. Matches scripts/storage-init.mjs and archived migration 0035's policies. */
export const MODEL_BUCKET = Deno.env.get("STORAGE_MODEL_BUCKET") ?? "asset-3d-models";

/**
 * The IDTA Digital Nameplate template whose element semanticIds this mapping attaches. It selects
 * rows from `idta_submodel_templates` and `idta_template_elements`, and is the semanticId of a nameplate
 * that holds every element the template asks for. The version is part of the identifier: 2.0 lives
 * under admin-shell.io/zvei, 3.0 under admin-shell.io/idta.
 */
export const NAMEPLATE_TEMPLATE_ID = "https://admin-shell.io/idta/nameplate/3/0/Nameplate";

/** IDTA Contact Information, which defines the elements of the nameplate's AddressInformation. */
export const CONTACT_INFORMATION_TEMPLATE_ID =
  "https://admin-shell.io/zvei/nameplate/1/0/ContactInformations";

/** The collection of Contact Information whose elements AddressInformation takes. */
const CONTACT_INFORMATION_PATH = "ContactInformation";
const ADDRESS_INFORMATION = "AddressInformation";

/**
 * What a nameplate's AddressInformation must hold. The Nameplate's specification names the four
 * (*Mandatory information for address information*) and no template file does: Contact Information
 * marks each one optional. The Nameplate dialog's copy is in frontend/src/utils/nameplate.js.
 */
export const MANDATORY_ADDRESS_ELEMENTS = ["Street", "Zipcode", "CityTown", "NationalCode"] as const;

/**
 * The OPC 40001 Machinery identification members a device can publish a nameplate value under, by
 * the ExpandedNodeId opcua_vocabulary carries for each: a catalog metric with that semantic id
 * answers the field. Check 46 of scripts/check-docs-drift.mjs holds each id to its seed row.
 */
export const OPC_MACHINERY = {
  Manufacturer: "nsu=http://opcfoundation.org/UA/Machinery/;i=6002",
  Model: "nsu=http://opcfoundation.org/UA/Machinery/;i=6008",
  SerialNumber: "nsu=http://opcfoundation.org/UA/Machinery/;i=6003",
  ProductInstanceUri: "nsu=http://opcfoundation.org/UA/Machinery/;i=6015",
  SoftwareRevision: "nsu=http://opcfoundation.org/UA/Machinery/;i=6011",
  YearOfConstruction: "nsu=http://opcfoundation.org/UA/Machinery/;i=6004",
} as const;

/**
 * Cap on a model bundled into an AASX: what may be held in memory, deflated and concatenated inside
 * one edge worker, as opposed to the bucket's storage limit. Over the cap the export falls back to
 * the URL reference, which is still a valid shell.
 */
export const MAX_BUNDLED_MODEL_BYTES = Number.parseInt(
  Deno.env.get("AAS_MAX_BUNDLED_MODEL_BYTES") ?? "33554432",
  10,
);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a base URL points at the loopback interface. `AAS_MODEL_PUBLIC_BASE` defaults to a
 * localhost address, which is right for a developer clicking Export and wrong for every other
 * consumer of the shell. `0.0.0.0` is included because it is a bind address people paste by
 * mistake.
 */
export function isLoopbackBase(base: string): boolean {
  try {
    const host = new URL(base).hostname.toLowerCase();
    // Substrings, not equality: `api.127.0.0.1.nip.io` is a hostname whose every resolution is
    // loopback, and it is what the chart's dev domain produces.
    return host.includes("localhost") || host.includes("127.0.0.1") || host === "::1" ||
      host === "[::1]" || host === "0.0.0.0";
  } catch {
    // An unparseable base is a different misconfiguration and is not this function's to report.
    return false;
  }
}

export const MODEL_BASE_IS_LOOPBACK = isLoopbackBase(MODEL_PUBLIC_BASE);

/**
 * What to tell an operator whose model URL will not resolve anywhere but this host. Names the
 * variable and what to set it to.
 */
export const MODEL_BASE_ADVICE =
  `AAS_MODEL_PUBLIC_BASE is '${MODEL_PUBLIC_BASE}', which resolves only on this host. ` +
  "Set it to the address other machines use to reach this stack's Storage endpoint -- the LAN IP " +
  "or DNS name, e.g. http://10.20.0.50:54321/storage/v1/object/public/asset-3d-models -- and " +
  "verify it resolves from inside the container that will consume the shell.";

// Element builders

/**
 * An AAS `Reference` to an external concept, or undefined when the concept is unmapped, so
 * `JSON.stringify` drops the `semanticId` key.
 */
export function semanticReference(semanticId?: string | null) {
  if (!semanticId) return undefined;
  return {
    type: "ExternalReference",
    keys: [{ type: "GlobalReference", value: semanticId }],
  };
}

/**
 * The `supplementalSemanticIds` of an element: a Reference for each further id of the same concept,
 * each once and never the element's own, or undefined when there are none, so `JSON.stringify` drops
 * the key (the list is `minItems: 1`). All three id types export as `semanticReference()` does.
 */
export function supplementalReferences(ids?: readonly string[] | null, ownId?: string | null) {
  const distinct = [...new Set((ids ?? []).filter((id) => id && id !== ownId))];
  return distinct.length > 0 ? distinct.map((id) => semanticReference(id)) : undefined;
}

/**
 * AAS idShort: the metamodel's pattern is ^[a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9_]+$. It must start with
 * a letter (prefixing a digit-leading name with `_` is still invalid; "3-Axis Mill" is an ordinary
 * device name) and be at least two characters.
 */
export function toIdShort(value: string, fallback: string): string {
  let cleaned = (value || "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned) return fallback;
  if (!/^[A-Za-z]/.test(cleaned)) cleaned = `Id_${cleaned}`;
  if (cleaned.length < 2) cleaned = `${cleaned}_`;
  return cleaned;
}

export function property(
  idShort: string,
  valueType: string,
  value: unknown,
  opts: {
    semanticId?: string | null;
    supplementalSemanticIds?: readonly string[] | null;
    description?: string | null;
  } = {},
) {
  return {
    modelType: "Property",
    idShort,
    valueType,
    // AAS serialises every Property value as a string, and the metamodel has no "exists but unset"
    // value, so an unpublished metric omits `value` entirely rather than carrying null.
    value: value === null || value === undefined ? undefined : String(value),
    semanticId: semanticReference(opts.semanticId),
    // Only beside a semanticId (AASd-118): a further id without one has no concept to be further to.
    supplementalSemanticIds: opts.semanticId
      ? supplementalReferences(opts.supplementalSemanticIds, opts.semanticId)
      : undefined,
    description: opts.description
      ? [{ language: "en", text: String(opts.description).slice(0, 1023) }]
      : undefined,
  };
}

/** The AAS schema's limit on one text of a MultiLanguageProperty. */
const MAX_LANG_STRING_LENGTH = 1023;

/**
 * A MultiLanguageProperty holding one text. Aber stores the text and not its language, so it is
 * tagged `en`, as every text the exporter writes is: the Nameplate's specification asks for at most
 * one string, in any language.
 */
export function multiLanguageProperty(
  idShort: string,
  text: string,
  opts: { semanticId?: string | null; description?: string | null } = {},
) {
  return {
    modelType: "MultiLanguageProperty",
    idShort,
    value: [{ language: "en", text }],
    semanticId: semanticReference(opts.semanticId),
    description: opts.description
      ? [{ language: "en", text: String(opts.description).slice(0, 1023) }]
      : undefined,
  };
}

/**
 * A SubmodelElementCollection, or undefined when it would be empty: `value` is `minItems: 1` in the
 * schema, so an empty collection is invalid.
 */
export function collection(
  idShort: string,
  value: unknown[],
  description?: string,
  semanticId?: string | null,
) {
  if (!value || value.length === 0) return undefined;
  return {
    modelType: "SubmodelElementCollection",
    idShort,
    semanticId: semanticReference(semanticId),
    description: description ? [{ language: "en", text: description }] : undefined,
    value,
  };
}

/**
 * An AAS `File` submodel element, a reference to a document held outside the shell. `contentType`
 * is how a consumer picks a loader, derived from the extension; see model3dContentType.ts.
 */
export function file(idShort: string, value: string, contentType: string, description?: string) {
  return {
    modelType: "File",
    idShort,
    contentType,
    value,
    description: description ? [{ language: "en", text: description }] : undefined,
  };
}

/**
 * The metric names one schema models: `properties` keys plus `required` entries. One of five
 * implementations, kept in step by test-harness/fixtures/modelled-metrics.json with
 * `frontend/src/utils/deviceTags.js`, `ingestion/validate.py`, `i3x/i3x_service.py` and the database;
 * test_aas_export.py extracts this function by regex and executes it, so the signature tokens are
 * part of the contract. An array `properties` contributes nothing: `Object.keys(["a","b"])` is
 * `["0","1"]`, which fails the idShort pattern. Returns a sorted array so two exports of the same
 * device are byte-comparable; the contract compares as sets.
 */
export function modelledMetrics(definition: Record<string, unknown> | null): string[] {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return [];
  const props = definition.properties;
  const required = definition.required;
  const names = new Set<string>();
  if (props && typeof props === "object" && !Array.isArray(props)) {
    for (const key of Object.keys(props as Record<string, unknown>)) names.add(key);
  }
  if (Array.isArray(required)) {
    for (const key of required) if (typeof key === "string") names.add(key);
  }
  return [...names].sort();
}

/**
 * The elementId the i3X server gives a device, or one of its metrics: `<sparkplug_id>/<metric name>`.
 * i3x/address_space.py mints the same and splits it at the first `/`, since a sparkplug_id has none.
 */
export function i3xElementId(sparkplugId: string, metricName?: string): string {
  return metricName === undefined ? sparkplugId : `${sparkplugId}/${metricName}`;
}

/**
 * A definition in words, as the Metrics page says it: "rate of Controller/PART_COUNT, per hour",
 * "share of time Controller/EXECUTION is ACTIVE", "Power/PHASE_A + Power/PHASE_B − Power/PHASE_C".
 * Kept in step with describeDerivation() in frontend/src/utils/derivedMetric.js.
 */
export function describeDerivation(derivation: Record<string, unknown> | null): string {
  if (!derivation || typeof derivation !== "object") return "";
  if (derivation.kind === "counter_rate") return `rate of ${derivation.input}, per hour`;
  if (derivation.kind === "time_in_state") {
    const states = (Array.isArray(derivation.states) ? derivation.states : []).map(String);
    const list = states.length > 1
      ? `${states.slice(0, -1).join(", ")} or ${states[states.length - 1]}`
      : states.join("");
    return `share of time ${derivation.input} is ${list}`;
  }
  if (derivation.kind === "sum") {
    const inputs = (Array.isArray(derivation.inputs) ? derivation.inputs : []) as {
      metric?: unknown;
      sign?: unknown;
    }[];
    return inputs
      .map((input, i) => {
        const minus = Number(input.sign) < 0;
        const name = String(input.metric);
        return i === 0 ? (minus ? `−${name}` : name) : `${minus ? " − " : " + "}${name}`;
      })
      .join("");
  }
  return "";
}

/**
 * The derived metrics of a device: each catalog row with a definition that one of its schemas names, in
 * name order. `schemas` are the ones the metrics come from, which for a replay lane are its original's.
 * One rule with device_derived_metrics() (0336) and the dashboard's derivedMetricsOfDevice(), which
 * test-harness/fixtures/device-derived-metrics.json holds together.
 */
export function derivedMetricsFor(
  schemas: Record<string, unknown>[],
  catalog: Record<string, unknown>[],
): Record<string, unknown>[] {
  const named = new Set(
    schemas.flatMap((s) => (Array.isArray(s.derived_metrics) ? s.derived_metrics : [])).map(String),
  );
  return catalog
    .filter((m) => m.derivation && named.has(String(m.name)))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// Concept descriptions

/**
 * The IEC 61360 data specification template, IDTA-01003-a 3.1. `…/3/0` is its deprecated
 * spelling. AASc-3a-050 requires this reference beside every IEC 61360 content.
 */
export const IEC61360_TEMPLATE =
  "https://admin-shell.io/DataSpecificationTemplates/DataSpecificationIec61360/3";

const IEC61360_BY_SPARKPLUG: Record<number, string> = {
  11: "BOOLEAN",
  12: "STRING",
  13: "TIMESTAMP",
  14: "STRING",
  15: "STRING",
  17: "BLOB",
  18: "FILE",
};

/**
 * The IEC 61360 `dataType` for a Sparkplug datatype code, or undefined where none fits (DataSet,
 * Template, an unknown code). A number is a MEASURE only with a unit, because AASc-3a-009 requires
 * one on every MEASURE type, and a COUNT without.
 */
export function sparkplugToIec61360(
  code: number | null | undefined,
  hasUnit: boolean,
): string | undefined {
  if (code === null || code === undefined) return undefined;
  if (code >= 1 && code <= 8) return hasUnit ? "INTEGER_MEASURE" : "INTEGER_COUNT";
  if (code === 9 || code === 10) return hasUnit ? "REAL_MEASURE" : "REAL_COUNT";
  return IEC61360_BY_SPARKPLUG[code];
}

/**
 * Every GlobalReference a semanticId or a supplementalSemanticIds list in `node` names, sorted, each
 * once.
 */
export function referencedSemanticIds(node: unknown): string[] {
  const ids = new Set<string>();
  type Reference = { keys?: { type?: string; value?: string }[] };
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      const { semanticId, supplementalSemanticIds } = value as {
        semanticId?: Reference;
        supplementalSemanticIds?: Reference[];
      };
      const further = Array.isArray(supplementalSemanticIds) ? supplementalSemanticIds : [];
      for (const reference of [semanticId, ...further]) {
        for (const key of reference?.keys ?? []) {
          if (key.type === "GlobalReference" && key.value) ids.add(key.value);
        }
      }
      Object.values(value).forEach(walk);
    }
  };
  walk(node);
  return [...ids].sort();
}

/** The last segment of an IRI, which names the concept in every vocabulary here; null otherwise. */
function conceptName(id: string): string | null {
  if (!/^(https?:\/\/|urn:)/i.test(id)) return null;
  const tail = id.split(/[/#]/).filter(Boolean).pop() ?? "";
  return /^[A-Za-z]/.test(tail) ? tail : null;
}

/**
 * Authorities that issue ids no vocabulary here holds in full, by IRI prefix. Such an id is defined
 * by its authority, whatever standard the metrics carrying it are filed under, so its definition
 * defers there and never to a metric's description. A row in `concept_definitions` still takes
 * precedence: QUDT's seeded quantity kinds are defined by their own text, and this is for one the
 * seed leaves out, a deprecated kind or one a later release added.
 */
export const ID_AUTHORITIES: readonly { prefix: string; authority: string }[] = [
  { prefix: "http://qudt.org/vocab/quantitykind/", authority: "QUDT" },
];

function authorityOf(id: string): string | undefined {
  return ID_AUTHORITIES.find((a) => id.startsWith(a.prefix))?.authority;
}

/** The single distinct non-empty value, or undefined when there are none or they disagree. */
function onlyValue(values: unknown[]): string | undefined {
  const distinct = [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))];
  return distinct.length === 1 ? distinct[0] : undefined;
}

/**
 * The IEC 61360 `unitId` for a metric's unit: the QUDT unit that is exactly that MTConnect unit name,
 * as an ExternalReference with one GlobalReference key, or undefined where the crosswalk maps the name
 * to none. `unit` keeps the MTConnect name as free text beside it.
 */
function unitReference(unit: string | undefined) {
  if (unit === undefined || !Object.hasOwn(QUDT_UNIT_IDS, unit)) return undefined;
  return {
    type: "ExternalReference",
    keys: [{ type: "GlobalReference", value: QUDT_UNIT_IDS[unit] }],
  };
}

/** Where an id's definition comes from, as `concept_sources` records it, or undefined where it records none. */
function sourceOfDefinition(
  sources: readonly ConceptSource[] | undefined,
  id: string,
): string | undefined {
  return sources?.find((s) => s.semantic_id === id)?.source || undefined;
}

/**
 * How a site names the file a concept came from: a published standard by its citation
 * (`ISO 22400-2:2014`), the site's own vocabulary by the file's name.
 */
export function siteFileLabel(file: SiteVocabularyRef | null | undefined): string {
  if (file?.kind === "published_standard" && file.standard_name) {
    return file.standard_edition ? `${file.standard_name}:${file.standard_edition}` : file.standard_name;
  }
  return file?.name ?? "the site's vocabulary";
}

/**
 * What an imported site vocabulary says of an id: its preferred name always, and its definition only
 * where the Administrator confirmed that the licence lets it be shared. Otherwise the IEC 61360
 * definition, which is mandatory in English, defers to the file ("<name>, as <file> defines it.").
 * It never falls back to a catalog description, which may be a copy of the licensed text. A seeded
 * standard that defines the id comes first, as in `concept_definitions`: the site's is last.
 */
export function siteDefinitionFor(
  id: string,
  defined: ConceptDefinition | undefined,
  siteConcepts: readonly SiteConcept[] | undefined,
): { name: string; definition: string } | undefined {
  if (defined?.standard) return undefined;
  const concept = siteConcepts?.find((c) => c.semantic_id === id);
  if (!concept) return undefined;
  const name = concept.preferred_name;
  const text = String(concept.definition ?? "").trim();
  const shared = concept.site_vocabularies?.definitions_shareable === true && text !== "";
  return { name, definition: shared ? text : `${name}, as ${siteFileLabel(concept.site_vocabularies)} defines it.` };
}

/**
 * Whether a metric's own description stays out of an export: one of its ids is held by an imported
 * vocabulary whose definitions are not shared. The description may be a copy of the licensed text,
 * which is why `siteDefinitionFor()` never lets it define such an id either.
 */
export function withholdsDescription(
  ids: readonly (string | null | undefined)[],
  siteConcepts: readonly SiteConcept[] | undefined,
): boolean {
  return ids.some((id) => {
    const concept = id ? siteConcepts?.find((c) => c.semantic_id === id) : undefined;
    return concept !== undefined && concept.site_vocabularies?.definitions_shareable !== true;
  });
}

/**
 * Whether a metric is a key performance indicator: ISO 22400 names it, or it was started from an
 * imported file that is a published standard named ISO 22400 (by prefix, as `ISO 22400-2` is).
 */
export function isKpiMetric(
  metric: Record<string, unknown> | undefined,
  siteVocabularies: readonly SiteVocabularyRef[] | undefined,
): boolean {
  if (metric?.standard === "ISO 22400") return true;
  const linked = metric?.site_vocabulary_id;
  if (!linked) return false;
  const file = siteVocabularies?.find((v) => v.id === linked);
  return file?.kind === "published_standard" && String(file.standard_name ?? "").startsWith("ISO 22400");
}

function conceptDescription(
  id: string,
  name: string,
  definition: string,
  opts: {
    unit?: string;
    unitId?: ReturnType<typeof unitReference>;
    dataType?: string;
    sourceOfDefinition?: string;
  } = {},
) {
  return {
    modelType: "ConceptDescription",
    id,
    idShort: toIdShort(name, "Concept"),
    embeddedDataSpecifications: [{
      dataSpecification: {
        type: "ExternalReference",
        keys: [{ type: "GlobalReference", value: IEC61360_TEMPLATE }],
      },
      dataSpecificationContent: {
        modelType: "DataSpecificationIec61360",
        preferredName: [{ language: "en", text: name.slice(0, 255) }],
        unit: opts.unit,
        unitId: opts.unitId,
        sourceOfDefinition: opts.sourceOfDefinition,
        dataType: opts.dataType,
        // Mandatory in English (AASc-3a-008), so every source below supplies one.
        definition: [{ language: "en", text: definition.slice(0, 1023) }],
      },
    }],
  };
}

/** The IEC 61360 `dataType` of a template's element, or undefined where none fits (a collection). */
function iec61360OfElement(element: TemplateElement): string | undefined {
  if (element.model_type === "MultiLanguageProperty") return "STRING_TRANSLATABLE";
  if (element.model_type !== "Property") return undefined;
  if (element.value_type === "xs:date") return "DATE";
  return element.value_type === "xs:anyURI" ? "IRI" : "STRING";
}

/**
 * One ConceptDescription per semantic id, from rows the shell was built from: the nameplate's
 * templates, else the catalog rows carrying the id, else the schema. The definition is the
 * vocabulary's own text (`concept_definitions`) wherever a vocabulary defines the id, so one
 * metric's description never defines a standard concept. An id under one of ID_AUTHORITIES defers
 * to that authority. For any other id, a catalog description is the definition only when every
 * live row carrying the id agrees on it, since several metrics can share one concept (#457). The
 * unit and datatype come from the catalog rows on the same terms. The units are MTConnect UnitEnum
 * names, which IEC 61360 `unit` takes as free text; `unitId` is the QUDT unit the crosswalk maps the
 * name to (qudtUnits.ts), and is left out for a name that maps to none. An id an imported site
 * vocabulary holds takes the file's preferred name, and its definition only where the file's
 * definitions are shared (`siteDefinitionFor()`), whatever the catalog describes.
 */
export function buildConceptDescriptions(
  ids: string[],
  rows:
    & Pick<DeviceRecord, "catalog" | "templates" | "schemas" | "definitions">
    & Partial<Pick<DeviceRecord, "elements" | "sources" | "siteConcepts">>,
): Record<string, unknown>[] {
  const definedBy = new Map(rows.definitions.map((d) => [d.semantic_id, d]));
  const elements = rows.elements ?? [];
  return ids.map((id) => {
    const template = rows.templates.find((t) => t.semantic_id === id);
    // A row's own `definition` is what the template says of the element, not of its concept, and no
    // IEC CDD or ECLASS text is held, so an element's id is defined by naming the element.
    const element = elements.find((e) => e.semantic_id === id);
    if (template) {
      return conceptDescription(
        id,
        template.id_short,
        template.description || `The IDTA 02006 nameplate element ${template.id_short}.`,
        { dataType: element ? iec61360OfElement(element) : "STRING" },
      );
    }
    if (element) {
      const name = element.id_short ?? element.path;
      return conceptDescription(
        id,
        name,
        `The ${element.template_number} ${element.template_name} element ${name}.`,
        { dataType: iec61360OfElement(element) },
      );
    }
    const claimed = elements.find((e) => e.template_id === id);
    if (claimed) {
      return conceptDescription(
        id,
        claimed.template_name,
        `The submodel template ${claimed.template_number}, ${claimed.template_name}. A submodel that ` +
          "carries this id holds the elements the template asks for.",
      );
    }

    const defined = definedBy.get(id);
    const site = siteDefinitionFor(id, defined, rows.siteConcepts);
    const authority = authorityOf(id);
    const carrying = rows.catalog.filter((m) => m.semantic_id === id);
    const live = carrying.filter((m) => !m.deprecated);
    const metrics = live.length > 0 ? live : carrying;
    if (metrics.length > 0) {
      const named = conceptName(id);
      const name = site?.name ?? named ?? defined?.name ?? String(metrics.map((m) => m.name).sort()[0]);
      const source = authority ?? onlyValue(metrics.map((m) => m.standard));
      const units = new Set(metrics.map((m) => String(m.units ?? "").trim()).filter(Boolean));
      const unit = units.size === 1 ? [...units][0] : undefined;
      const datatype = onlyValue(metrics.map((m) => m.datatype));
      // Without one agreed description, or under an authority, the definition defers to the
      // identifier's source.
      const deferred = !named
        ? `The concept identified by ${id}.`
        : source
        ? `${name}, as ${source} defines it.`
        : `${name}, a local extension with no recorded definition.`;
      const described = authority ? undefined : onlyValue(metrics.map((m) => m.description));
      return conceptDescription(
        id,
        name,
        site?.definition ?? defined?.definition ?? described ?? deferred,
        {
          unit,
          unitId: unitReference(unit),
          sourceOfDefinition: defined || authority ? sourceOfDefinition(rows.sources, id) : undefined,
          // Units that disagree leave the type unsaid: MEASURE needs one unit, COUNT claims none.
          dataType: units.size > 1 || datatype === undefined
            ? undefined
            : sparkplugToIec61360(Number(datatype), unit !== undefined),
        },
      );
    }

    const schema = rows.schemas.find((s) => s.semantic_id === id);
    const name = site?.name ?? conceptName(id) ?? defined?.name ?? String(schema?.schema_name ?? "Concept");
    const definition = site?.definition || defined?.definition ||
      (authority ? `${name}, as ${authority} defines it.` : schema?.description as string | null) ||
      `The concept ${name}, which this shell references.`;
    return conceptDescription(id, name, definition, {
      sourceOfDefinition: defined || authority ? sourceOfDefinition(rows.sources, id) : undefined,
    });
  });
}

/**
 * The further semantic ids of each metric (`metric_semantic_ids`), by the metric's id: each list
 * sorted and without repeats, so two exports of one device agree.
 */
export function supplementalIdsByMetric(
  rows: readonly SupplementalSemanticId[] | undefined,
): Map<string, string[]> {
  const byMetric = new Map<string, string[]>();
  for (const row of rows ?? []) {
    if (!row.metric_id || !row.semantic_id) continue;
    const ids = byMetric.get(String(row.metric_id)) ?? [];
    if (!ids.includes(row.semantic_id)) ids.push(row.semantic_id);
    byMetric.set(String(row.metric_id), ids);
  }
  for (const ids of byMetric.values()) ids.sort();
  return byMetric;
}

/**
 * The semantic ids a shell built from these rows can reference, besides the nameplate template's:
 * those of the catalog metrics the attached schemas model, their further ids, and the schemas' own.
 * The loader reads `concept_definitions` for exactly these, so it must cover what buildEnvironment()
 * references.
 */
export function conceptIdsFor(
  rows: Pick<DeviceRecord, "catalog" | "schemas"> & Partial<Pick<DeviceRecord, "supplemental">>,
): string[] {
  const catalogByName = new Map(rows.catalog.map((m) => [String(m.name), m]));
  const supplemental = supplementalIdsByMetric(rows.supplemental);
  const ids = new Set<string>();
  for (const schema of rows.schemas) {
    if (schema.semantic_id) ids.add(String(schema.semantic_id));
    const modelled = modelledMetrics(
      (schema.schema_definition as Record<string, unknown> | null) ?? null,
    );
    for (const name of modelled) {
      const metric = catalogByName.get(name);
      const id = metric?.semantic_id;
      if (!id) continue;
      ids.add(String(id));
      for (const further of supplemental.get(String(metric?.id)) ?? []) ids.add(further);
    }
  }
  return [...ids].sort();
}

// Loading

/** Everything one shell is built from. Rows exactly as PostgREST returns them. */
export interface DeviceRecord {
  device: Record<string, unknown>;
  config: Record<string, unknown>[];
  links: { schema_id: string; submodel_key: string | null }[];
  catalog: Record<string, unknown>[];
  gateway: Record<string, unknown> | null;
  nameplate: Record<string, unknown> | null;
  templates: { id_short: string; semantic_id: string; description?: string | null }[];
  /** The elements of the Digital Nameplate and Contact Information, as `idta_template_elements` holds them. */
  elements?: TemplateElement[];
  schemas: Record<string, unknown>[];
  /** A replay lane's original's schemas, which its derived metrics come from. Absent, they come from `schemas`. */
  derivedSchemas?: Record<string, unknown>[];
  /** The further semantic ids of the catalog's metrics, as `metric_semantic_ids` holds them. */
  supplemental?: SupplementalSemanticId[];
  /** `concept_definitions` rows for the ids conceptIdsFor() names. */
  definitions: ConceptDefinition[];
  /** `concept_sources` rows for the same ids: where a vocabulary's definition comes from. */
  sources?: ConceptSource[];
  /** The imported site vocabularies' concepts for the same ids, each with the file it comes from. */
  siteConcepts?: SiteConcept[];
  /** The files the catalog's metrics link to (`metric_catalog.site_vocabulary_id`), for the KPI split. */
  siteVocabularies?: SiteVocabularyRef[];
}

/** A file in `site_vocabularies`: what the exporter needs to say where a concept came from. */
export interface SiteVocabularyRef {
  id?: string;
  name?: string;
  kind: string;
  standard_name?: string | null;
  standard_edition?: string | null;
  definitions_shareable?: boolean;
}

/** A row of `site_vocabulary_concepts`, with its file embedded as PostgREST returns it. */
export interface SiteConcept {
  semantic_id: string;
  preferred_name: string;
  definition?: string | null;
  site_vocabularies?: SiteVocabularyRef | null;
}

/** A row of `idta_template_elements`: an element of a submodel template, as the template's file has it. */
export interface TemplateElement {
  template_id: string;
  template_name: string;
  template_number: string;
  path: string;
  parent_path: string | null;
  ordinal: number;
  id_short: string | null;
  model_type: string;
  value_type?: string | null;
  semantic_id?: string | null;
  cardinality?: string | null;
}

/** A row of `metric_semantic_ids`: another published id of the concept a catalog metric measures. */
export interface SupplementalSemanticId {
  metric_id: string;
  semantic_id: string;
  semantic_id_type?: string | null;
}

/** A row of `concept_definitions`: a vocabulary's own name and text for a semantic id. */
export interface ConceptDefinition {
  semantic_id: string;
  name: string;
  definition: string;
  /** NULL for a site vocabulary's concept: it is no standard Aber ships. */
  standard: string | null;
}

/** A row of `concept_sources`: the citation of the vocabulary a semantic id's definition is read from. */
export interface ConceptSource {
  semantic_id: string;
  source: string;
}

/** Any Supabase client. Deliberately structural: the authority is the caller's to choose. */
// deno-lint-ignore no-explicit-any
type Client = any;

/**
 * Read every row one device's shell is composed from, or null when there is no such device. The eight
 * independent reads run in parallel, since the REST API hits this per request; the schemas and then
 * the vocabulary definitions follow, because each needs the rows before it.
 */
export async function loadDeviceRecord(
  client: Client,
  deviceId: string,
): Promise<DeviceRecord | null> {
  const { data: deviceRows, error: deviceError } = await client
    .from("devices")
    .select("*")
    .eq("id", deviceId);

  if (deviceError) throw new Error(deviceError.message);

  const device = deviceRows?.[0];
  if (!device) return null;

  // asset_config is keyed by sparkplug_id, written by ingestion from the DBIRTH payload.
  // `device_schemas` is one row per device_submodels row: every schema attached to the device.
  const [
    { data: configRows },
    { data: linkRows },
    { data: catalogRows },
    { data: gatewayRows },
    { data: nameplateRows },
    { data: templateRows },
    { data: elementRows },
    { data: supplementalRows },
  ] = await Promise.all([
    client.from("asset_config").select("*").eq("asset_id", device.sparkplug_id),
    client.from("device_schemas").select("schema_id, submodel_key").eq("device_id", device.id),
    client.from("metric_catalog").select("*"),
    device.gateway_id
      ? client.from("gateways").select("name,sparkplug_id").eq("id", device.gateway_id)
      : Promise.resolve({ data: [] }),
    client.from("device_nameplate").select("*").eq("device_id", device.id),
    client.from("idta_submodel_templates").select("id_short, semantic_id, description")
      .eq("template_id", NAMEPLATE_TEMPLATE_ID),
    // Without rows (an error, or a database that lacks the table) a nameplate claims no template.
    client.from("idta_template_elements")
      .select("template_id, template_name, template_number, path, parent_path, ordinal, id_short, model_type, value_type, semantic_id, cardinality")
      .in("template_id", [NAMEPLATE_TEMPLATE_ID, CONTACT_INFORMATION_TEMPLATE_ID]),
    // Without rows (an error, or a database that lacks the table) each metric exports its own id alone.
    client.from("metric_semantic_ids").select("metric_id, semantic_id, semantic_id_type"),
  ]);

  const links = linkRows ?? [];
  const schemaIds = links.map((l: { schema_id: string }) => l.schema_id).filter(Boolean);
  const { data: schemaRows } = schemaIds.length > 0
    ? await client.from("schemas").select("*").in("id", schemaIds)
    : { data: [] };

  // A replay lane has its original's derived metrics, whatever its own bindings say by now.
  let derivedSchemas: Record<string, unknown>[] | undefined;
  if (device.shadow_of) {
    const { data: originalLinks } = await client.from("device_schemas").select("schema_id").eq("device_id", device.shadow_of);
    const originalIds = (originalLinks ?? []).map((l: { schema_id: string }) => l.schema_id).filter(Boolean);
    const { data: originalSchemas } = originalIds.length > 0
      ? await client.from("schemas").select("id, derived_metrics").in("id", originalIds)
      : { data: [] };
    derivedSchemas = originalSchemas ?? [];
  }

  // One query for every vocabulary definition the shell can use. Without rows (an error, or a
  // database that lacks the view) each definition falls back to the catalog text.
  const conceptIds = conceptIdsFor({
    catalog: catalogRows ?? [],
    schemas: schemaRows ?? [],
    supplemental: supplementalRows ?? [],
  });
  // Started first, so it runs beside the definitions. Without rows (an error, or a database that lacks
  // the view) no definition names its source.
  const sourcesRequest = conceptIds.length > 0
    ? client.from("concept_sources").select("semantic_id, source").in("semantic_id", conceptIds)
    : Promise.resolve({ data: [] });
  const { data: definitionRows } = conceptIds.length > 0
    ? await client.from("concept_definitions").select("semantic_id, name, definition, standard")
      .in("semantic_id", conceptIds)
    : { data: [] };
  const { data: sourceRows } = await sourcesRequest;

  // The imported site vocabularies, for the same ids and for the files the catalog links to. Without
  // rows (an error, or a database that lacks the tables) an id keeps its other definitions.
  const { data: siteConceptRows } = conceptIds.length > 0
    ? await client.from("site_vocabulary_concepts")
      .select("semantic_id, preferred_name, definition, site_vocabularies(name, kind, standard_name, standard_edition, definitions_shareable)")
      .in("semantic_id", conceptIds)
    : { data: [] };
  const linked = [...new Set((catalogRows ?? []).map((m: Record<string, unknown>) => m.site_vocabulary_id).filter(Boolean))];
  const { data: siteVocabularyRows } = linked.length > 0
    ? await client.from("site_vocabularies").select("id, name, kind, standard_name, standard_edition").in("id", linked)
    : { data: [] };

  return {
    device,
    config: configRows ?? [],
    links,
    catalog: catalogRows ?? [],
    gateway: gatewayRows?.[0] ?? null,
    nameplate: nameplateRows?.[0] ?? null,
    templates: templateRows ?? [],
    elements: elementRows ?? [],
    schemas: schemaRows ?? [],
    ...(derivedSchemas ? { derivedSchemas } : {}),
    supplemental: supplementalRows ?? [],
    definitions: definitionRows ?? [],
    sources: sourceRows ?? [],
    siteConcepts: siteConceptRows ?? [],
    siteVocabularies: siteVocabularyRows ?? [],
  };
}

// Construction

export interface BuiltShell {
  /** The AAS Part 5 Environment: what an AASX package holds and what AAS tools accept as JSON. */
  environment: Record<string, unknown>;
  /** The submodels, already inside `environment` -- exposed so the REST API can address them. */
  submodels: Record<string, unknown>[];
  /** The single shell, already inside `environment`, for the same reason. */
  shell: Record<string, unknown>;
  stats: Record<string, unknown>;
  /** `devices.model_3d_path`, or null. aas-export needs it to decide whether to bundle. */
  modelPath: string | null;
  modelUrl: string | null;
}

/**
 * The names a device's other identifiers go under in `specificAssetIds`. Consumers match on them,
 * so a rename is a break. `partInstanceId` is Catena-X's name; its `manufacturerPartId` is not
 * written, because `device_nameplate` has no article-number column.
 */
export const SPECIFIC_ASSET_ID_NAMES = {
  serialNumber: "partInstanceId",
  productUri: "uriOfTheProduct",
  sparkplugId: "sparkplugId",
} as const;

/** The AAS schema's `SpecificAssetId.value` limit. */
const MAX_SPECIFIC_ASSET_ID_LENGTH = 2048;

/** One entry of `assetInformation.specificAssetIds`. */
export interface SpecificAssetId {
  name: string;
  value: string;
  semanticId?: ReturnType<typeof semanticReference>;
}

/**
 * The `specificAssetIds` of the candidates that have a value, in order, or undefined when none
 * does: the schema's `minItems` is 1, so the key is left out. It takes identifiers, not a device
 * row, so a shell that is not a device can name its own. A value over 2048 characters is left out,
 * not cut.
 */
export function buildSpecificAssetIds(
  candidates: { name: string; value: unknown; semanticId?: SpecificAssetId["semanticId"] }[],
): SpecificAssetId[] | undefined {
  const ids: SpecificAssetId[] = [];
  for (const { name, value, semanticId } of candidates) {
    const text = value === null || value === undefined ? "" : String(value);
    if (text.trim() === "" || text.length > MAX_SPECIFIC_ASSET_ID_LENGTH) continue;
    ids.push({ name, value: text, semanticId });
  }
  return ids.length > 0 ? ids : undefined;
}

/**
 * The elements a nameplate must hold to claim its template, as idShortPaths in the template's order:
 * the top-level elements it asks for (One or OneToMany), with AddressInformation as the address
 * elements its specification asks for. Empty without the template's rows, so nothing can claim it.
 */
export function mandatoryNameplatePaths(elements: readonly TemplateElement[] | undefined): string[] {
  return (elements ?? [])
    .filter((e) =>
      e.template_id === NAMEPLATE_TEMPLATE_ID && e.parent_path === null &&
      (e.cardinality === "One" || e.cardinality === "OneToMany")
    )
    .sort((a, b) => a.ordinal - b.ordinal)
    .flatMap((e) =>
      e.path === ADDRESS_INFORMATION
        ? MANDATORY_ADDRESS_ELEMENTS.map((name) => `${ADDRESS_INFORMATION}.${name}`)
        : [e.path]
    );
}

/**
 * Compose one device's AAS Environment from the rows `loadDeviceRecord()` returned. Pure: no I/O
 * and no environment beyond the module constants, so the same graph is reproducible from a fixture.
 */
export function buildEnvironment(record: DeviceRecord): BuiltShell {
  const { device, config, links, catalog, gateway, nameplate, templates, schemas, definitions } =
    record;
  const supplementalByMetric = supplementalIdsByMetric(record.supplemental);

  const keyBySchema = new Map<string, string | null>(
    links.map((l) => [String(l.schema_id), l.submodel_key ?? null]),
  );

  const catalogByName = new Map<string, Record<string, unknown>>();
  for (const metric of catalog) catalogByName.set(String(metric.name), metric);

  const configByName = new Map<string, Record<string, unknown>>();
  for (const entry of config) configByName.set(String(entry.metric_name), entry);

  /** The birth value for a metric, in whichever column ingestion put it. */
  const valueFor = (name: string): unknown => {
    const row = configByName.get(name);
    if (!row) return null;
    if (row.val_double !== null && row.val_double !== undefined) return row.val_double;
    if (row.val_bool !== null && row.val_bool !== undefined) return row.val_bool;
    if (row.val_string !== null && row.val_string !== undefined) return row.val_string;
    return null;
  };

  const globalAssetId = globalAssetIdOf(String(device.sparkplug_id));
  const shellIdShort = toIdShort(String(device.name ?? ""), "Device");
  const submodelId = (suffix: string) => `${globalAssetId}/submodel/${suffix}`;

  let unmappedCount = 0;

  /**
   * One AAS Property per catalogued metric name: the metric's own id is its semanticId and its
   * further ids are its supplementalSemanticIds. Not here: a template's element id as the primary
   * one inside a schema built from that template, which Build Schema from Template adds.
   */
  const propertyFor = (name: string) => {
    const metric = catalogByName.get(name);
    const semanticId = (metric?.semantic_id as string | null) ?? null;
    if (!semanticId) unmappedCount += 1;
    const further = supplementalByMetric.get(String(metric?.id));
    return {
      metric,
      element: property(
        toIdShort(name, "Metric"),
        sparkplugToXsd(metric?.datatype as number | undefined),
        valueFor(name),
        {
          semanticId,
          supplementalSemanticIds: further,
          description: withholdsDescription([semanticId, ...(further ?? [])], record.siteConcepts)
            ? null
            : (metric?.description as string | null) ?? null,
        },
      ),
    };
  };

  // Submodel 1: Digital Nameplate. Each element carries its template's semanticId and type. The submodel
  // carries the template's own id only where every element the template asks for is here. Values are
  // resolved device-first, with `device_nameplate` as the fallback. The join is on semantic id, not
  // metric name: the catalog's semantic_id is the assertion that two differently named metrics mean
  // the same concept.
  const templateElements = record.elements ?? [];
  const nameplateElements = new Map(
    templateElements
      .filter((e) => e.template_id === NAMEPLATE_TEMPLATE_ID && e.parent_path === null)
      .map((e) => [e.path, e]),
  );
  const addressElements = new Map(
    templateElements
      .filter((e) =>
        e.template_id === CONTACT_INFORMATION_TEMPLATE_ID && e.parent_path === CONTACT_INFORMATION_PATH
      )
      .map((e) => [e.id_short, e]),
  );
  const nameplateSemanticId = new Map<string, string>(
    templates.map((row) => [String(row.id_short), String(row.semantic_id)]),
  );

  // A metric carrying the id as its own answers before one carrying it as a further id, so adding a
  // further id never moves a field from the metric that was answering it.
  const catalogBySemanticId = new Map<string, Record<string, unknown>>();
  for (const metric of catalog) {
    const id = metric.semantic_id as string | null;
    if (id && !catalogBySemanticId.has(id)) catalogBySemanticId.set(id, metric);
  }
  for (const metric of catalog) {
    if (!metric.semantic_id) continue;
    for (const id of supplementalByMetric.get(String(metric.id)) ?? []) {
      if (!catalogBySemanticId.has(id)) catalogBySemanticId.set(id, metric);
    }
  }
  /** The device's own answer for a concept, or null when it publishes nothing for it. */
  const publishedValue = (semanticId: string): unknown => {
    const metric = catalogBySemanticId.get(semanticId);
    return metric ? valueFor(String(metric.name)) : null;
  };

  /** The idShortPaths of the nameplate elements this device has a value for. */
  const present = new Set<string>();
  const hasText = (value: unknown) => value !== null && value !== undefined && String(value).trim() !== "";

  /**
   * One nameplate element as its template types it, or null when there is no value. A value of spaces
   * is none, and so is a text longer than a MultiLanguageProperty may hold: it is left out, not cut.
   * Without the template's row (an error, or a database that lacks it) it is an xs:string Property.
   */
  const templateElement = (
    path: string,
    idShort: string,
    element: TemplateElement | undefined,
    value: unknown,
    opts: { semanticId: string | null; description: string },
  ) => {
    if (!hasText(value)) return null;
    const text = String(value);
    const multiLanguage = element?.model_type === "MultiLanguageProperty";
    if (multiLanguage && text.length > MAX_LANG_STRING_LENGTH) return null;
    present.add(path);
    return multiLanguage
      ? multiLanguageProperty(idShort, text, opts)
      : property(idShort, element?.value_type ?? "xs:string", text, opts);
  };

  const RECORDED = "Recorded against the asset by an operator.";

  /**
   * One nameplate element, sourced device-first and carrying its published id. A device that publishes
   * an empty value answers nothing, so the operator's stands. `source` is recorded in the description
   * rather than as a sibling property, which a consumer would read as a second nameplate field.
   */
  const nameplateElement = (
    idShort: string,
    operatorValue: unknown,
    opcSemanticId?: string,
  ) => {
    const published = opcSemanticId ? publishedValue(opcSemanticId) : null;
    const answered = hasText(published);
    const element = nameplateElements.get(idShort);
    return templateElement(idShort, idShort, element, answered ? published : operatorValue, {
      semanticId: nameplateSemanticId.get(idShort) ?? element?.semantic_id ?? null,
      description: answered ? "Published by the device at DBIRTH." : RECORDED,
    });
  };

  /** One element of AddressInformation: only an operator records one. */
  const addressElement = (idShort: string, value: unknown) => {
    const element = addressElements.get(idShort);
    return templateElement(`${ADDRESS_INFORMATION}.${idShort}`, idShort, element, value, {
      semanticId: element?.semantic_id ?? null,
      description: RECORDED,
    });
  };

  const nameplateElementsHeld = [
    nameplateElement("URIOfTheProduct", nameplate?.uri_of_the_product, OPC_MACHINERY.ProductInstanceUri),
    nameplateElement("ManufacturerName", nameplate?.manufacturer_name, OPC_MACHINERY.Manufacturer),
    // The manufacturer's name for the product. The device's own name is the site's, and never stands in.
    nameplateElement(
      "ManufacturerProductDesignation",
      nameplate?.manufacturer_product_designation,
      OPC_MACHINERY.Model,
    ),
    collection(
      ADDRESS_INFORMATION,
      [
        addressElement("Street", nameplate?.address_street),
        addressElement("Zipcode", nameplate?.address_zipcode),
        addressElement("CityTown", nameplate?.address_city_town),
        addressElement("StateCounty", nameplate?.address_state_county),
        addressElement("NationalCode", nameplate?.address_national_code),
      ].filter((element) => element !== null),
      undefined,
      nameplateSemanticId.get(ADDRESS_INFORMATION) ?? nameplateElements.get(ADDRESS_INFORMATION)?.semantic_id,
    ) ?? null,
    nameplateElement("ManufacturerProductType", nameplate?.manufacturer_product_type),
    nameplateElement("OrderCodeOfManufacturer", nameplate?.order_code_of_manufacturer),
    // SERIAL_NUMBER by name is the pre-semantic-id fallback: the demo schema publishes it under
    // that literal name, and metrics created before 0029 carry no semantic id to join on.
    nameplateElement(
      "SerialNumber",
      nameplate?.serial_number ?? valueFor("SERIAL_NUMBER"),
      OPC_MACHINERY.SerialNumber,
    ),
    nameplateElement("YearOfConstruction", nameplate?.year_of_construction, OPC_MACHINERY.YearOfConstruction),
    nameplateElement("DateOfManufacture", nameplate?.date_of_manufacture),
    nameplateElement("HardwareVersion", nameplate?.hardware_version),
    nameplateElement("FirmwareVersion", nameplate?.firmware_version ?? valueFor("Controller/FIRMWARE")),
    nameplateElement("SoftwareVersion", nameplate?.software_version, OPC_MACHINERY.SoftwareRevision),
    nameplateElement("CountryOfOrigin", nameplate?.country_of_origin),
  ].filter((element) => element !== null);

  const mandatory = mandatoryNameplatePaths(templateElements);
  const missing = mandatory.filter((path) => !present.has(path));
  const claimsTemplate = mandatory.length > 0 && missing.length === 0;

  const submodels: Record<string, unknown>[] = [];

  // Left out when it would hold nothing: an empty submodel would say the device has a nameplate.
  if (nameplateElementsHeld.length > 0) {
    submodels.push({
      modelType: "Submodel",
      id: submodelId("Nameplate"),
      idShort: "DigitalNameplate",
      kind: "Instance",
      semanticId: claimsTemplate ? semanticReference(NAMEPLATE_TEMPLATE_ID) : undefined,
      submodelElements: nameplateElementsHeld,
    });
  }

  // Submodel: PlatformConnection, how this platform reaches the asset. No semanticId on it or in it,
  // because IDTA defines none for these and inventing one under admin-shell.io would be a forgery. Neither
  // a connection method (it is always Sparkplug B) nor a status (a live state a document cannot keep) is
  // here: i3X and the REST API serve a device's live state.
  submodels.push({
    modelType: "Submodel",
    id: submodelId("PlatformConnection"),
    idShort: "PlatformConnection",
    kind: "Instance",
    submodelElements: [
      property("AssetSparkplugId", "xs:string", device.sparkplug_id, {
        description: "Immutable wire identity; the same value keys telemetry in the historian.",
      }),
      property("EdgeGatewayName", "xs:string", gateway?.name ?? null),
      property("EdgeGatewaySparkplugId", "xs:string", gateway?.sparkplug_id ?? null),
    ],
  });

  // Per IDTA 02008: a segment whose records live outside the shell, named by an endpoint. This is
  // the standard's own answer to bulk history, and the reason none of it is inlined.
  const linkedSegment = collection(
    "LinkedSegment",
    [
      property("Endpoint", "xs:anyURI", HISTORIAN_ENDPOINT),
      property("Query", "xs:string", `asset_id=eq.${device.sparkplug_id}`),
    ],
    "Historical samples for this asset. Query the endpoint filtered by asset_id.",
  );

  // The same history from the i3X server, its standard read API, while the chart publishes one: by
  // the elementIds of the submodel's own metrics. The query is the request's JSON body, to which a
  // client adds startTime and endTime. The PostgREST segment stays for a site that turns i3X off.
  const i3xSegment = (names: string[]) =>
    I3X_HISTORY_ENDPOINT
      ? collection(
        "I3XLinkedSegment",
        [
          property("Endpoint", "xs:anyURI", I3X_HISTORY_ENDPOINT),
          property(
            "Query",
            "xs:string",
            JSON.stringify({ elementIds: names.map((name) => i3xElementId(String(device.sparkplug_id), name)) }),
          ),
        ],
        "Historical samples for these metrics, from the i3X server. POST the query to the endpoint, " +
          "with a startTime and an endTime added and a bearer token.",
      )
      : undefined;

  // One Submodel per attached schema, each attachment being its own aspect. A schema is still split
  // by `metric_catalog.standard` when it mixes provenances, so KeyPerformanceIndicators stays
  // meaningful for a schema that carries ISO 22400 KPIs beside MTConnect observations.
  let telemetryTotal = 0;
  let kpiTotal = 0;

  // The key in each Submodel's id comes from the schema's lineage, so a publish leaves it where it
  // was. `lineage_name` and `lineage_root_id` are on every row since 0298; a row without them (a
  // fixture) is its own lineage.
  const { keys: submodelKeys, clashes: keyClashes } = assignSubmodelKeys(
    schemas.map((schema) => ({
      id: String(schema.id),
      rootId: String(schema.lineage_root_id ?? schema.id),
      rootKey: toIdShort(String(schema.lineage_name || schema.schema_name || ""), "Submodel"),
      version: Number(schema.version) || 1,
      status: String(schema.status ?? "active"),
      declaredKey: keyBySchema.get(String(schema.id)) ?? null,
    })),
  );

  for (const schema of schemas) {
    const modelled = modelledMetrics(
      (schema.schema_definition as Record<string, unknown> | null) ?? null,
    );
    const telemetryProps: unknown[] = [];
    const telemetryNames: string[] = [];
    const kpiProps: unknown[] = [];

    for (const name of modelled) {
      const { metric, element } = propertyFor(name);
      if (isKpiMetric(metric, record.siteVocabularies)) {
        kpiProps.push(element);
      } else {
        telemetryProps.push(element);
        telemetryNames.push(name);
      }
    }

    telemetryTotal += telemetryProps.length;
    kpiTotal += kpiProps.length;

    const baseKey = submodelKeys.get(String(schema.id)) as string;
    const single = schemas.length === 1;
    // The schema version that produced the Submodel: a consumer that cached one sees it move.
    const administration = { version: String(Number(schema.version) || 1) };

    if (telemetryProps.length > 0) {
      const elements = [collection("Metrics", telemetryProps)];
      if (linkedSegment) elements.push(collection("Segments", [linkedSegment, i3xSegment(telemetryNames)].filter(Boolean)));
      submodels.push({
        modelType: "Submodel",
        id: submodelId(`${baseKey}/OperationalTelemetry`),
        // Keeps the well-known idShort while only one schema is attached, so a consumer looking
        // for OperationalTelemetry still finds it; qualifies it once there is more than one.
        idShort: single ? "OperationalTelemetry" : `${baseKey}_OperationalTelemetry`,
        kind: "Instance",
        administration,
        semanticId: semanticReference((schema.semantic_id as string | null) ?? null),
        submodelElements: elements.filter(Boolean),
      });
    }

    if (kpiProps.length > 0) {
      submodels.push({
        modelType: "Submodel",
        id: submodelId(`${baseKey}/KeyPerformanceIndicators`),
        idShort: single ? "KeyPerformanceIndicators" : `${baseKey}_KeyPerformanceIndicators`,
        kind: "Instance",
        administration,
        submodelElements: kpiProps,
      });
    }
  }

  // Submodel: DerivedMetrics. A derived metric is in no schema's metrics and no birth, so the telemetry
  // submodels above never list it: this one adds each that one of the device's schemas names. No
  // semanticId, because it is a local extension (so it is counted as unmapped, the honest form), and
  // no value: a shell is the asset's description, and a current value would need a read of the
  // historian that the loader does not make. The description says how Aber computes it.
  const derivedRows = derivedMetricsFor(record.derivedSchemas ?? schemas, catalog);
  if (derivedRows.length > 0) {
    unmappedCount += derivedRows.length;
    submodels.push({
      modelType: "Submodel",
      id: submodelId("DerivedMetrics"),
      idShort: "DerivedMetrics",
      kind: "Instance",
      submodelElements: derivedRows.map((m) =>
        property(toIdShort(String(m.name), "Metric"), sparkplugToXsd(m.datatype as number | undefined), null, {
          description: `Computed by Aber, not published by the device: ${
            describeDerivation(m.derivation as Record<string, unknown>)
          }. It carries no semantic id.`,
        })
      ),
    });
  }

  // Submodel: VisualRepresentation (3D model). Emitted only when the device carries a model; an
  // empty submodel would assert the aspect exists and then fail to describe it. `model_3d_path`
  // holds an object key, and the absolute URL is composed from a configurable base.
  const modelPath = (device.model_3d_path as string | null) ?? null;
  const modelUrl = modelPath ? `${MODEL_PUBLIC_BASE}/${modelPath}` : null;

  if (modelPath && modelUrl) {
    submodels.push({
      modelType: "Submodel",
      id: submodelId("VisualRepresentation"),
      idShort: "VisualRepresentation",
      kind: "Instance",
      submodelElements: [
        file(
          // Not "3DModel": an idShort must start with a letter, and "_3DModel" is equally invalid.
          "Model3D",
          modelUrl,
          modelContentType(modelPath),
          `3D visual model for this asset (${modelFileName(modelPath)}).`,
        ),
      ],
    });
  }

  // The serial number and the product URI are what the Nameplate exports, with its semantic ids,
  // so the shell names them once. A replay lane is a recording of an asset, not a second asset,
  // and its DBIRTH repeats the original's serial number: it names none.
  const heldElement = (idShort: string) =>
    nameplateElementsHeld.find((element) => element.idShort === idShort);
  const serialNumber = heldElement("SerialNumber");
  const productUri = heldElement("URIOfTheProduct");
  const specificAssetIds = device.shadow_of ? undefined : buildSpecificAssetIds([
    {
      name: SPECIFIC_ASSET_ID_NAMES.serialNumber,
      value: serialNumber?.value,
      semanticId: serialNumber?.semanticId,
    },
    {
      name: SPECIFIC_ASSET_ID_NAMES.productUri,
      value: productUri?.value,
      semanticId: productUri?.semanticId,
    },
    { name: SPECIFIC_ASSET_ID_NAMES.sparkplugId, value: device.sparkplug_id },
  ]);

  const shell = {
    modelType: "AssetAdministrationShell",
    id: shellIdOf(String(device.sparkplug_id)),
    idShort: shellIdShort,
    assetInformation: {
      assetKind: "Instance",
      globalAssetId,
      specificAssetIds,
    },
    submodels: submodels.map((s) => ({
      type: "ModelReference",
      keys: [{ type: "Submodel", value: s.id as string }],
    })),
  };

  const conceptDescriptions = buildConceptDescriptions(referencedSemanticIds(submodels), {
    siteConcepts: record.siteConcepts,
    catalog,
    templates,
    elements: record.elements,
    schemas,
    definitions,
    sources: record.sources,
  });

  const environment = {
    // AAS Part 5 "Environment": the container serialisation, which is what an AASX package holds
    // and what every AAS tool accepts as a JSON drop-in.
    assetAdministrationShells: [shell],
    submodels,
    // One per semanticId above, since most resolve nowhere (#460). minItems: 1, so omitted when
    // the shell references none.
    ...(conceptDescriptions.length > 0 ? { conceptDescriptions } : {}),
  };

  const stats = {
    submodels: submodels.length,
    attached_schemas: schemas.length,
    telemetry_metrics: telemetryTotal,
    kpi_metrics: kpiTotal,
    derived_metrics: derivedRows.length,
    unmapped_semantic_ids: unmappedCount,
    // The submodels that carry a published template's id, and what the nameplate lacks before it can.
    claimed_templates: claimsTemplate ? 1 : 0,
    nameplate_missing_elements: missing.length,
    // Keys that were taken, by another lineage with the same name or by a declared key, and were
    // qualified with a short form of their lineage's id to stay apart.
    submodel_key_clashes: keyClashes,
    concept_descriptions: conceptDescriptions.length,
    has_3d_model: Boolean(modelPath),
    // A warning here and not a refusal: in the JSON export the URL is visible to the caller, and a
    // developer exporting on their own machine is the case the localhost default serves. The AASX
    // path treats the same condition as fatal, because that package claims to be self-contained.
    ...(modelPath && MODEL_BASE_IS_LOOPBACK
      ? { model_url_resolves_only_on_this_host: true }
      : {}),
  };

  return { environment, submodels, shell, stats, modelPath, modelUrl };
}
