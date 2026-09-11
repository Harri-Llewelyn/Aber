/**
 * The AAS mapping layer: rows in this database to an AAS V3 Environment, built once here and
 * presented by `aas-export` (a serialised file) and `aas-api` (the IDTA 02001/02002 REST surface).
 * The client is an argument: aas-export passes a service-role client, aas-api the caller's own, so
 * RLS applies to the live API. Every table read below carries `SELECT TO authenticated USING
 * (true)`; if that stops being true for one, the API's answer changes shape without erroring. AASX
 * packaging stays in aas-export.
 */
import { sparkplugToXsd } from "./sparkplugToXsd.ts";
import { modelContentType, modelFileName } from "./model3dContentType.ts";

// Configuration, read at module load and so per worker: main/index.ts spawns one worker per
// function with only the variables its registry entry names, so both aas-export and aas-api must
// declare the AAS_* set.

/** Namespace for asset and submodel ids. Configurable because an IRI must be resolvable for the
 *  organisation publishing it, and `acs-cymru.local` is only right for this stack. */
export const BASE_IRI = (Deno.env.get("AAS_BASE_IRI") ?? "https://acs-cymru.local/ids/asset/")
  .replace(/\/+$/, "") + "/";

/** Where a consumer fetches the actual samples. The shell points at this; it never embeds them. */
export const HISTORIAN_ENDPOINT =
  Deno.env.get("AAS_HISTORIAN_ENDPOINT") ?? "http://localhost:54321/rest/v1/telemetry";

/**
 * Public base for 3D model objects. `devices.model_3d_path` stores an object key, so the absolute
 * URL is composed here. It cannot be derived from SUPABASE_URL, which inside the compose network
 * resolves for nothing outside Docker, so it defaults to the published gateway address and is
 * overridden per deployment, like AAS_BASE_IRI.
 */
export const MODEL_PUBLIC_BASE = (
  Deno.env.get("AAS_MODEL_PUBLIC_BASE") ??
    "http://localhost:54321/storage/v1/object/public/asset-3d-models"
).replace(/\/+$/, "");

/** The bucket 3D models live in. Matches scripts/storage-init.mjs and archived migration 0035's policies. */
export const MODEL_BUCKET = Deno.env.get("STORAGE_MODEL_BUCKET") ?? "asset-3d-models";

/**
 * The IDTA Digital Nameplate template whose element semanticIds this mapping attaches. It selects
 * rows from `idta_submodel_templates` and is not placed on the exported submodel. The version is
 * part of the identifier: 2.0 lives under admin-shell.io/zvei, 3.0 under admin-shell.io/idta.
 */
export const NAMEPLATE_TEMPLATE_ID = "https://admin-shell.io/idta/nameplate/3/0/Nameplate";

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
    return host === "localhost" || host === "127.0.0.1" || host === "::1" ||
      host === "[::1]" || host === "0.0.0.0" || host.endsWith(".localhost");
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
  opts: { semanticId?: string | null; description?: string | null } = {},
) {
  return {
    modelType: "Property",
    idShort,
    valueType,
    // AAS serialises every Property value as a string, and the metamodel has no "exists but unset"
    // value, so an unpublished metric omits `value` entirely rather than carrying null.
    value: value === null || value === undefined ? undefined : String(value),
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
 * The metric names one schema models: `properties` keys plus `required` entries. The fourth of four
 * implementations, kept in step by test-harness/fixtures/modelled-metrics.json with
 * `frontend/src/utils/deviceTags.js`, `ingestion/validate.py` and `i3x/i3x_service.py`;
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

// Loading

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
 * Read every row one device's shell is composed from, or null when there is no such device. The six
 * reads are independent and run in parallel, since the REST API hits this per request.
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
  // `device_schemas` is the union of the device_submodels join and the legacy 1:1
  // devices.schema_id, so this resolves for a device provisioned by either path.
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
 * Compose one device's AAS Environment from the rows `loadDeviceRecord()` returned. Pure: no I/O
 * and no environment beyond the module constants, so the same graph is reproducible from a fixture.
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

  // Submodel 1: Digital Nameplate. Element-level semanticIds only; the submodel carries none,
  // because placing the IDTA 02006 template id on it would assert conformance to a template whose
  // mandatory elements this platform cannot guarantee. Values are resolved device-first, with
  // `device_nameplate` as the fallback. The join is on semantic id, not metric name: the catalog's
  // semantic_id is the assertion that two differently named metrics mean the same concept.
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
   * One nameplate property, sourced device-first and carrying its published IRDI. `source` is
   * recorded in the description rather than as a sibling property, which a consumer would read as a
   * second nameplate field.
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

  // One Submodel per attached schema, each attachment being its own aspect. A schema is still split
  // by `metric_catalog.standard` when it mixes provenances, so KeyPerformanceIndicators stays
  // meaningful for a schema that carries ISO 22400 KPIs beside MTConnect observations.
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
    // `conceptDescriptions` is minItems:1 in the schema, so the key is omitted rather than set to
    // an empty array. Every semanticId here is already a resolvable identifier.
  };

  const stats = {
    submodels: submodels.length,
    attached_schemas: schemas.length,
    telemetry_metrics: telemetryTotal,
    kpi_metrics: kpiTotal,
    unmapped_semantic_ids: unmappedCount,
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
