/**
 * The AAS mapping layer: rows in this database -> an AAS V3 Environment.
 *
 * WHY THIS IS SHARED RATHER THAN DUPLICATED. Two functions now answer questions about the same
 * asset in the same vocabulary -- `aas-export` serialises a whole shell as a file, and `aas-api`
 * serves the IDTA 02001/02002 REST surface over the live database. If each built the object graph
 * itself they would drift, and the failure mode is the worst kind available here: the `.aasx` a
 * customer holds and the endpoint their ERP queries would disagree about the same machine, both
 * reporting success. So the graph is constructed EXACTLY ONCE, here, and each function decides
 * only how to present it.
 *
 * ---------------------------------------------------------------------------------------------
 * THE CLIENT IS AN ARGUMENT, AND THAT IS THE SECURITY-RELEVANT PART.
 *
 * `loadDeviceRecord()` takes whatever Supabase client it is handed and never creates one. That is
 * what lets the two callers hold different authority over the same mapping code:
 *
 *   aas-export  a service-role client. It composes a document that aggregates tables an operator
 *               may read individually, and it has always done so.
 *   aas-api     the CALLER'S OWN client. A live read API over the whole asset space must not
 *               bypass RLS -- same reasoning as `fplus-directory`, whose registry entry in
 *               main/index.ts states it: granting the service key there would turn every
 *               authenticated user's lookup into a privileged one.
 *
 * Every table read below carries `SELECT TO authenticated USING (true)`, so the caller-context
 * path returns the same rows for any signed-in role rather than a silently thinner shell. If that
 * ever stops being true for one of them, the API's answer changes shape without erroring -- which
 * is why the list is written out here rather than left implicit.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE. AASX packaging (Open Packaging Conventions) stays in aas-export.
 * It is a serialisation of this output, not part of building it, and the REST API has no route
 * that returns one.
 */
import { sparkplugToXsd } from "./sparkplugToXsd.ts";
import { modelContentType, modelFileName } from "./model3dContentType.ts";

// ------------------------------------------------------------------------------------------------
// Configuration
//
// Read at module load, which means PER WORKER: main/index.ts spawns one worker per function with
// only the variables that function's registry entry names. Both aas-export and aas-api must
// therefore declare the AAS_* set, or the same asset would export under one identifier namespace
// and resolve under another.
// ------------------------------------------------------------------------------------------------

/** Namespace for asset and submodel ids. Configurable because an IRI must be resolvable for the
 *  organisation publishing it, and `acs-cymru.local` is only right for this stack. */
export const BASE_IRI = (Deno.env.get("AAS_BASE_IRI") ?? "https://acs-cymru.local/ids/asset/")
  .replace(/\/+$/, "") + "/";

/** Where a consumer fetches the actual samples. The shell points at this; it never embeds them. */
export const HISTORIAN_ENDPOINT =
  Deno.env.get("AAS_HISTORIAN_ENDPOINT") ?? "http://localhost:54321/rest/v1/telemetry";

/**
 * Public base for 3D model objects. `devices.model_3d_path` stores an object KEY, never a URL, so
 * the absolute URL is composed here -- the same arrangement as the historian endpoint above, and
 * for the same reason: a URL baked into a row is wrong the moment the deployment moves.
 *
 * It cannot be derived from SUPABASE_URL. Inside the compose network that is
 * `http://supabase-kong:8000`, which resolves for this worker and for nothing outside Docker; a
 * shell handed to a partner would carry an unreachable link. So it defaults to the published
 * gateway address and is overridden per deployment, exactly like AAS_BASE_IRI.
 */
export const MODEL_PUBLIC_BASE = (
  Deno.env.get("AAS_MODEL_PUBLIC_BASE") ??
    "http://localhost:54321/storage/v1/object/public/asset-3d-models"
).replace(/\/+$/, "");

/** The bucket 3D models live in. Matches scripts/storage-init.mjs and archived migration 0035's policies. */
export const MODEL_BUCKET = Deno.env.get("STORAGE_MODEL_BUCKET") ?? "asset-3d-models";

/**
 * The IDTA Digital Nameplate template whose element semanticIds this mapping attaches.
 *
 * NOT an environment variable, and not on the exported submodel either -- it selects rows from
 * `idta_submodel_templates` (seeded by archived migration 0011) and nothing more. The version is part of
 * the identifier: 2.0 lives under admin-shell.io/zvei, 3.0 under admin-shell.io/idta, and a shell
 * that mixed them would name two different templates.
 */
export const NAMEPLATE_TEMPLATE_ID = "https://admin-shell.io/idta/nameplate/3/0/Nameplate";

/**
 * Cap on a model bundled into an AASX. The bucket's own limit is 50 MB, but that governs what may
 * be *stored*; this governs what may be held in memory, deflated and concatenated inside a single
 * edge worker. Over the cap the export falls back to the URL reference, which is still a valid
 * shell -- degraded, not failed.
 */
export const MAX_BUNDLED_MODEL_BYTES = Number.parseInt(
  Deno.env.get("AAS_MAX_BUNDLED_MODEL_BYTES") ?? "33554432",
  10,
);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a base URL points at the loopback interface.
 *
 * WHY THIS MATTERS AT ALL. `AAS_MODEL_PUBLIC_BASE` defaults to `http://localhost:54321/...`, which
 * is correct for a developer clicking Export on their own machine and wrong for every other
 * consumer of the resulting shell. Inside an Eclipse BaSyx container, `localhost` is BaSyx; on a
 * partner's laptop it is their laptop. The reference resolves to nothing and the failure reads as
 * a broken export rather than as an unset variable.
 *
 * `0.0.0.0` is included because it is a bind address that people paste into a base URL by mistake;
 * it is never routable as a destination.
 */
export function isLoopbackBase(base: string): boolean {
  try {
    const host = new URL(base).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" ||
      host === "[::1]" || host === "0.0.0.0" || host.endsWith(".localhost");
  } catch {
    // An unparseable base is a different misconfiguration and is not this function's to report.
    return false;
  }
}

export const MODEL_BASE_IS_LOOPBACK = isLoopbackBase(MODEL_PUBLIC_BASE);

/**
 * What to tell an operator whose model URL will not resolve anywhere but this host.
 *
 * Names the variable AND what to set it to, because "configure the public base" is advice nobody
 * can action without knowing it means the address other machines use to reach this host.
 */
export const MODEL_BASE_ADVICE =
  `AAS_MODEL_PUBLIC_BASE is '${MODEL_PUBLIC_BASE}', which resolves only on this host. ` +
  "Set it to the address other machines use to reach this stack's Storage endpoint -- the LAN IP " +
  "or DNS name, e.g. http://10.20.0.50:54321/storage/v1/object/public/asset-3d-models -- and " +
  "verify it resolves from inside the container that will consume the shell.";

// ------------------------------------------------------------------------------------------------
// Element builders
// ------------------------------------------------------------------------------------------------

/**
 * An AAS `Reference` to an external concept, or undefined when the concept is unmapped.
 *
 * Returning undefined rather than a placeholder is the whole point: `JSON.stringify` drops an
 * undefined property, so an unmapped metric simply has no `semanticId` key.
 */
export function semanticReference(semanticId?: string | null) {
  if (!semanticId) return undefined;
  return {
    type: "ExternalReference",
    keys: [{ type: "GlobalReference", value: semanticId }],
  };
}

/**
 * AAS idShort: a restricted identifier. The metamodel's pattern is
 *
 *     ^[a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9_]+$
 *
 * which is stricter than "letters, digits and underscore" in two ways that are easy to miss and
 * that the official schema rejects outright:
 *
 *   * it must START WITH A LETTER. Prefixing a digit-leading name with `_` is NOT a valid fix --
 *     the result is still invalid, just differently.
 *     Entirely reachable here: a device called "3-Axis Mill" or "3D Printer 01" is ordinary.
 *   * it is at least TWO characters, so a one-character name needs padding rather than passing
 *     through.
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
  opts: { semanticId?: string | null; description?: string | null } = {},
) {
  return {
    modelType: "Property",
    idShort,
    valueType,
    // AAS serialises every Property value as a STRING, whatever its valueType says -- the schema
    // declares `value: { type: "string" }`. A raw number or boolean fails validation, and so does
    // `null`: the metamodel has no "exists but unset" value, it expresses that by the field being
    // absent. So an unpublished metric omits `value` entirely rather than carrying null.
    value: value === null || value === undefined ? undefined : String(value),
    semanticId: semanticReference(opts.semanticId),
    description: opts.description
      ? [{ language: "en", text: String(opts.description).slice(0, 1023) }]
      : undefined,
  };
}

/**
 * A SubmodelElementCollection, or undefined when it would be empty.
 *
 * `SubmodelElementCollection.value` is `minItems: 1` in the schema, so an empty collection is not
 * merely useless -- it is invalid. Same shape of rule as `conceptDescriptions` and the reason both
 * are omitted rather than emitted hollow.
 */
export function collection(idShort: string, value: unknown[], description?: string) {
  if (!value || value.length === 0) return undefined;
  return {
    modelType: "SubmodelElementCollection",
    idShort,
    description: description ? [{ language: "en", text: description }] : undefined,
    value,
  };
}

/**
 * An AAS `File` submodel element -- a reference to a document or artefact held outside the shell.
 *
 * `contentType` is not optional in practice even though the schema does not require it: it is how
 * a consumer picks a loader, and a 3D model whose type it cannot determine is a model it will not
 * render. Derived from the extension rather than from whatever MIME type the browser reported at
 * upload time -- see model3dContentType.ts for why those disagree across machines.
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
 * The metric names one schema models: `properties` keys plus `required` entries.
 *
 * THE FOURTH OF FOUR IMPLEMENTATIONS, and the fixture in test-harness/fixtures/modelled-metrics.json is
 * what keeps them in step -- `frontend/src/utils/deviceTags.js`, `ingestion/validate.py` and
 * `i3x/i3x_service.py` are the others. It moved here from aas-export/index.ts when aas-api began
 * sharing this mapping; test_aas_export.py extracts it BY REGEX from this file and executes it, so
 * the signature tokens it strips are part of the contract and not merely style.
 *
 * AN ARRAY `properties` CONTRIBUTES NOTHING, which is the divergence the fixture exists to catch.
 * `Object.keys(["a","b"])` is `["0","1"]`, and "0" does not satisfy the AAS idShort pattern, which
 * requires a leading letter. So the shell fails validation at the CONSUMER while this function
 * reports success. An array is not a valid JSON Schema `properties` object; it contributes nothing.
 *
 * RETURNS A SORTED ARRAY where the mirrors return a set. That is a rendering choice, not a
 * semantic one: Submodel elements are emitted in this order, and sorting makes two exports of the
 * same device byte-comparable. The contract compares the two as sets.
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

// ------------------------------------------------------------------------------------------------
// Loading
// ------------------------------------------------------------------------------------------------

/** Everything one shell is built from. Rows exactly as PostgREST returns them. */
export interface DeviceRecord {
  device: Record<string, unknown>;
  config: Record<string, unknown>[];
  links: { schema_id: string; submodel_key: string | null }[];
  catalog: Record<string, unknown>[];
  gateway: Record<string, unknown> | null;
  nameplate: Record<string, unknown> | null;
  templates: { id_short: string; semantic_id: string }[];
  schemas: Record<string, unknown>[];
}

/** Any Supabase client. Deliberately structural: the authority is the caller's to choose. */
// deno-lint-ignore no-explicit-any
type Client = any;

/**
 * Read every row one device's shell is composed from, or null when there is no such device.
 *
 * The six parallel reads were one `Promise.all` in the exporter and stay one here: they are
 * independent, and serialising them would multiply the round trip by six on a path the REST API
 * hits per request rather than per download.
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

  // asset_config is keyed by sparkplug_id, not by the row id -- it is written by ingestion from
  // the DBIRTH payload, which only knows the wire identity.
  //
  // `device_schemas` (archived migration 0034) is the union of the device_submodels join and the legacy
  // 1:1 devices.schema_id, so this resolves for a device provisioned by either path.
  const [
    { data: configRows },
    { data: linkRows },
    { data: catalogRows },
    { data: gatewayRows },
    { data: nameplateRows },
    { data: templateRows },
  ] = await Promise.all([
    client.from("asset_config").select("*").eq("asset_id", device.sparkplug_id),
    client.from("device_schemas").select("schema_id, submodel_key").eq("device_id", device.id),
    client.from("metric_catalog").select("*"),
    device.gateway_id
      ? client.from("gateways").select("name,sparkplug_id").eq("id", device.gateway_id)
      : Promise.resolve({ data: [] }),
    client.from("device_nameplate").select("*").eq("device_id", device.id),
    client.from("idta_submodel_templates").select("id_short, semantic_id")
      .eq("template_id", NAMEPLATE_TEMPLATE_ID),
  ]);

  const links = linkRows ?? [];
  const schemaIds = links.map((l: { schema_id: string }) => l.schema_id).filter(Boolean);
  const { data: schemaRows } = schemaIds.length > 0
    ? await client.from("schemas").select("*").in("id", schemaIds)
    : { data: [] };

  return {
    device,
    config: configRows ?? [],
    links,
    catalog: catalogRows ?? [],
    gateway: gatewayRows?.[0] ?? null,
    nameplate: nameplateRows?.[0] ?? null,
    templates: templateRows ?? [],
    schemas: schemaRows ?? [],
  };
}

// ------------------------------------------------------------------------------------------------
// Construction
// ------------------------------------------------------------------------------------------------

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
 * Compose one device's AAS Environment from the rows `loadDeviceRecord()` returned.
 *
 * PURE. It performs no I/O and reads no environment beyond the module constants above, which is
 * what makes the same graph reproducible from a fixture in a test without a database.
 */
export function buildEnvironment(record: DeviceRecord): BuiltShell {
  const { device, config, links, catalog, gateway, nameplate, templates, schemas } = record;

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

  const globalAssetId = `${BASE_IRI}${device.sparkplug_id}`;
  const shellIdShort = toIdShort(String(device.name ?? ""), "Device");
  const submodelId = (suffix: string) => `${globalAssetId}/submodel/${suffix}`;

  let unmappedCount = 0;

  /** One AAS Property per catalogued metric name. */
  const propertyFor = (name: string) => {
    const metric = catalogByName.get(name);
    const semanticId = (metric?.semantic_id as string | null) ?? null;
    if (!semanticId) unmappedCount += 1;
    return {
      metric,
      element: property(
        toIdShort(name, "Metric"),
        sparkplugToXsd(metric?.datatype as number | undefined),
        valueFor(name),
        { semanticId, description: (metric?.description as string | null) ?? null },
      ),
    };
  };

  // ---- Submodel 1: Digital Nameplate -------------------------------------------------------
  //
  // ELEMENT-LEVEL semanticIds ONLY, and the submodel deliberately carries NONE.
  //
  // Putting https://admin-shell.io/idta/nameplate/3/0/Nameplate on the submodel would assert
  // conformance to IDTA 02006, whose mandatory elements include URIOfTheProduct,
  // ManufacturerName and an AddressInformation collection -- none of which this platform can
  // guarantee for a device somebody registered this morning. Claiming the template id and then
  // omitting its mandatory elements is the AAS version of minting an id under mtconnect.org:
  // it asserts an interoperability nobody agreed to, and a consumer that trusts the id gets a
  // shell that fails validation against the template it names. The IRDIs below say what each
  // property MEANS, which is the useful half and is true.
  //
  // Values are resolved device-first: where a device publishes its own identification, that is
  // what the shell reports, and `device_nameplate` is the fallback for the many devices that
  // publish none. The join is on SEMANTIC ID, not on metric name -- a device may call its serial
  // number anything, and the catalog's semantic_id is precisely the assertion that two
  // differently-named metrics mean the same concept.
  const nameplateSemanticId = new Map<string, string>(
    templates.map((row) => [String(row.id_short), String(row.semantic_id)]),
  );

  const catalogBySemanticId = new Map<string, Record<string, unknown>>();
  for (const metric of catalog) {
    const id = metric.semantic_id as string | null;
    if (id && !catalogBySemanticId.has(id)) catalogBySemanticId.set(id, metric);
  }
  /** The device's own answer for a concept, or null when it publishes nothing for it. */
  const publishedValue = (semanticId: string): unknown => {
    const metric = catalogBySemanticId.get(semanticId);
    return metric ? valueFor(String(metric.name)) : null;
  };

  /**
   * One nameplate property, sourced device-first and carrying its published IRDI.
   *
   * `source` is recorded in the description rather than as a sibling property: an AAS consumer
   * reading ManufacturerName wants the name, and a second element next to it saying where the
   * name came from would be indistinguishable from a second nameplate field.
   */
  const nameplateProperty = (
    idShort: string,
    operatorValue: unknown,
    opcSemanticId?: string,
  ) => {
    const published = opcSemanticId ? publishedValue(opcSemanticId) : null;
    const value = published ?? operatorValue ?? null;
    if (value === null || value === undefined || value === "") return null;
    return property(idShort, "xs:string", value, {
      semanticId: nameplateSemanticId.get(idShort) ?? null,
      description: published !== null
        ? "Published by the device at DBIRTH."
        : "Recorded against the asset by an operator.",
    });
  };

  const OPC_MACHINERY = "http://opcfoundation.org/UA/Machinery/";
  const nameplateProps = [
    nameplateProperty("URIOfTheProduct", nameplate?.uri_of_the_product, `${OPC_MACHINERY}ProductInstanceUri`),
    nameplateProperty("ManufacturerName", nameplate?.manufacturer_name, `${OPC_MACHINERY}Manufacturer`),
    // Falls back to the device's own name, which is the only designation that always exists.
    nameplateProperty(
      "ManufacturerProductDesignation",
      nameplate?.manufacturer_product_designation ?? device.name,
      `${OPC_MACHINERY}Model`,
    ),
    nameplateProperty("ManufacturerProductType", nameplate?.manufacturer_product_type),
    // SERIAL_NUMBER by name is the pre-semantic-id fallback: the demo schema publishes it under
    // that literal name, and metrics created before 0029 carry no semantic id to join on.
    nameplateProperty(
      "SerialNumber",
      nameplate?.serial_number ?? valueFor("SERIAL_NUMBER"),
      `${OPC_MACHINERY}SerialNumber`,
    ),
    nameplateProperty("YearOfConstruction", nameplate?.year_of_construction, `${OPC_MACHINERY}YearOfConstruction`),
    nameplateProperty("DateOfManufacture", nameplate?.date_of_manufacture),
    nameplateProperty("HardwareVersion", nameplate?.hardware_version),
    nameplateProperty("FirmwareVersion", nameplate?.firmware_version ?? valueFor("Controller/FIRMWARE")),
    nameplateProperty("SoftwareVersion", nameplate?.software_version, `${OPC_MACHINERY}SoftwareRevision`),
    nameplateProperty("CountryOfOrigin", nameplate?.country_of_origin),

    // Factory+ concepts. No semanticId, because IDTA defines none for them and inventing one
    // under admin-shell.io would be a forgery -- see supabase/migrations/archive/20260101000029_semantic_identifiers.sql's header.
    property("AssetSparkplugId", "xs:string", device.sparkplug_id, {
      description: "Immutable wire identity; the same value keys telemetry in the historian.",
    }),
    property("ConnectionMethod", "xs:string", device.connection_method),
    property("EdgeGatewayName", "xs:string", gateway?.name ?? null),
    property("EdgeGatewaySparkplugId", "xs:string", gateway?.sparkplug_id ?? null),
    property("Status", "xs:string", device.status),
  ].filter((element): element is Record<string, unknown> => element !== null);

  const submodels: Record<string, unknown>[] = [
    {
      modelType: "Submodel",
      id: submodelId("Nameplate"),
      idShort: "DigitalNameplate",
      kind: "Instance",
      submodelElements: nameplateProps,
    },
  ];

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

  // ---- One Submodel per attached schema -------------------------------------------
  // Before device_submodels existed this was a single schema split by provenance into a fixed
  // pair of submodels. Each attachment is now its own aspect, which is what an AAS Submodel
  // means -- and a schema whose metrics are all ISO 22400 becomes a KPI submodel rather than a
  // telemetry one carrying a KPI section.
  //
  // A schema is still split by `metric_catalog.standard` when it mixes provenances, because the
  // demo schema deliberately does: one schema, three standards. Splitting keeps
  // KeyPerformanceIndicators meaningful without forcing operators to maintain two schemas.
  let telemetryTotal = 0;
  let kpiTotal = 0;

  for (const schema of schemas) {
    const modelled = modelledMetrics(
      (schema.schema_definition as Record<string, unknown> | null) ?? null,
    );
    const telemetryProps: unknown[] = [];
    const kpiProps: unknown[] = [];

    for (const name of modelled) {
      const { metric, element } = propertyFor(name);
      if (metric?.standard === "ISO 22400") kpiProps.push(element);
      else telemetryProps.push(element);
    }

    telemetryTotal += telemetryProps.length;
    kpiTotal += kpiProps.length;

    // The operator's chosen idShort where device_submodels carries one, otherwise derived from
    // the schema name. Derived rather than stored by default, so it cannot drift from the name.
    const declaredKey = keyBySchema.get(String(schema.id));
    const baseKey = declaredKey || toIdShort(String(schema.schema_name || ""), "Submodel");
    const single = schemas.length === 1;

    if (telemetryProps.length > 0) {
      const elements = [collection("Metrics", telemetryProps)];
      if (linkedSegment) elements.push(collection("Segments", [linkedSegment]));
      submodels.push({
        modelType: "Submodel",
        id: submodelId(`${baseKey}/OperationalTelemetry`),
        // Keeps the well-known idShort while only one schema is attached, so a consumer looking
        // for OperationalTelemetry still finds it; qualifies it once there is more than one.
        idShort: single ? "OperationalTelemetry" : `${baseKey}_OperationalTelemetry`,
        kind: "Instance",
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
        submodelElements: kpiProps,
      });
    }
  }

  // ---- Submodel: VisualRepresentation (3D model) -------------------------------------------
  // Emitted only when the device actually carries a model. An empty submodel would assert the
  // aspect exists and then fail to describe it -- the same rule as the omitted `semanticId` and
  // the omitted empty collection, and the reason `submodelElements` is not padded with a blank
  // File element instead.
  //
  // `model_3d_path` holds an object KEY. The absolute URL is composed here from a configurable
  // base, so the same row exports a localhost link on a dev stack and a real one in production
  // without the database knowing which it is.
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
          // NOT "3DModel", which is what it reads as and what the AAS metamodel forbids: an
          // idShort must start with a letter. The official schema rejects "3DModel" and equally
          // rejects "_3DModel", so there is no prefixing fix -- the name has to lead with a letter.
          "Model3D",
          modelUrl,
          modelContentType(modelPath),
          `3D visual model for this asset (${modelFileName(modelPath)}).`,
        ),
      ],
    });
  }

  const shell = {
    modelType: "AssetAdministrationShell",
    id: `${globalAssetId}/shell`,
    idShort: shellIdShort,
    assetInformation: {
      assetKind: "Instance",
      globalAssetId,
    },
    submodels: submodels.map((s) => ({
      type: "ModelReference",
      keys: [{ type: "Submodel", value: s.id as string }],
    })),
  };

  const environment = {
    // AAS Part 5 "Environment": the container serialisation, which is what an AASX package holds
    // and what every AAS tool accepts as a JSON drop-in.
    assetAdministrationShells: [shell],
    submodels,
    // `conceptDescriptions` is minItems:1 in the schema, so an empty array is INVALID -- the key
    // is omitted instead. Nothing is lost: every semanticId here is already a resolvable
    // identifier, and empty ConceptDescriptions would be noise rather than interoperability.
  };

  const stats = {
    submodels: submodels.length,
    attached_schemas: schemas.length,
    telemetry_metrics: telemetryTotal,
    kpi_metrics: kpiTotal,
    unmapped_semantic_ids: unmappedCount,
    has_3d_model: Boolean(modelPath),
    // Surfaced rather than left to be discovered by a consumer who cannot fetch the model.
    // A WARNING here and not a refusal: in the JSON export the URL is visible to the caller,
    // and a developer exporting on their own machine is the case the localhost default exists
    // to serve. The AASX path treats the same condition as fatal, because there the package
    // claims to be self-contained and is not.
    ...(modelPath && MODEL_BASE_IS_LOOPBACK
      ? { model_url_resolves_only_on_this_host: true }
      : {}),
  };

  return { environment, submodels, shell, stats, modelPath, modelUrl };
}
