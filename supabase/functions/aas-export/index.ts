/**
 * AAS export: emit an Asset Administration Shell (IEC 63278) V3 JSON document for one device.
 *
 * This is Phase 3 of the Option B roadmap -- an *adapter*, not a migration. The database keeps its
 * own shape (see migration 0029's header for why a native AAS metamodel was rejected: recursive
 * RLS, a third identifier namespace, a fourth type system) and this function projects it into AAS
 * on the way out. Nothing upstream knows AAS exists.
 *
 * WHAT IS AND IS NOT EMITTED
 *
 *   * Telemetry VALUES are never inlined. The Time Series submodel carries a `LinkedSegment`
 *     pointing at the historian, which is what IDTA 02008 defines that element for -- bulk history
 *     belongs in TimescaleDB, and a shell that embedded it would be unbounded in size.
 *   * A missing `semanticId` is OMITTED, never emitted as an empty Reference. `semantic_id` is
 *     nullable on purpose ("unmapped" is a legitimate state for a local extension), and an empty
 *     Reference is an invalid one -- worse than an absent optional field, because it asserts a
 *     mapping exists and then fails to name it. The response reports the unmapped count instead,
 *     so the gap is visible without being fabricated.
 *   * Submodels are composed from the device's single schema by provenance (`metric_catalog.standard`),
 *     because `devices.schema_id` is 1:1 today. When the `device_submodels` join table lands
 *     (Phase 5) this composition is what it replaces.
 *
 * SECURITY. Same posture as approve-quarantine: the caller's own JWT resolves their role, the
 * service-role client is used only after that check passes, and anything short of an allowed role
 * is 401/403. This matters more here than for most endpoints -- a shell aggregates nameplate,
 * configuration and documentation into a single payload, so it is a broader disclosure than any of
 * the tables it reads.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { zipSync, strToU8 } from "https://esm.sh/fflate@0.8.2";
import { sparkplugToXsd } from "./sparkplugToXsd.ts";
import { modelContentType, modelFileName } from "./model3dContentType.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

// Read access, deliberately wider than approve-quarantine's write access: an export is a read, and
// Operator/Auditor are the roles that would actually need to hand a shell to a partner. Still an
// allow-list, so an unmapped role is refused rather than defaulted.
const ALLOWED_ROLES = ["Administrator", "Shopfloor_Manager", "Operator", "Auditor"];

/** Namespace for asset and submodel ids. Configurable because an IRI must be resolvable for the
 *  organisation publishing it, and `factoryplus.local` is only right for this stack. */
const BASE_IRI = (Deno.env.get("AAS_BASE_IRI") ?? "https://factoryplus.local/ids/asset/")
  .replace(/\/+$/, "") + "/";

/** Where a consumer fetches the actual samples. The shell points at this; it never embeds them. */
const HISTORIAN_ENDPOINT =
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
const MODEL_PUBLIC_BASE = (
  Deno.env.get("AAS_MODEL_PUBLIC_BASE") ??
    "http://localhost:54321/storage/v1/object/public/asset-3d-models"
).replace(/\/+$/, "");

/** The bucket 3D models live in. Matches scripts/storage-init.mjs and migration 0035's policies. */
const MODEL_BUCKET = Deno.env.get("STORAGE_MODEL_BUCKET") ?? "asset-3d-models";

/**
 * Cap on a model bundled into an AASX. The bucket's own limit is 50 MB, but that governs what may
 * be *stored*; this governs what may be held in memory, deflated and concatenated inside a single
 * edge worker. Over the cap the export falls back to the URL reference, which is still a valid
 * shell -- degraded, not failed.
 */
const MAX_BUNDLED_MODEL_BYTES = Number.parseInt(
  Deno.env.get("AAS_MAX_BUNDLED_MODEL_BYTES") ?? "33554432",
  10,
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: jsonHeaders });

async function resolveUserRole(
  supabaseUser: ReturnType<typeof createClient>,
  userId: string,
  jwtRole: string | null,
): Promise<string | null> {
  const { data } = await supabaseUser
    .from("user_roles")
    .select("roles(name)")
    .eq("user_id", userId)
    .maybeSingle();

  const dbRole = (data as { roles?: { name?: string } } | null)?.roles?.name;
  if (typeof dbRole === "string") return dbRole;
  return jwtRole;
}

/**
 * An AAS `Reference` to an external concept, or undefined when the concept is unmapped.
 *
 * Returning undefined rather than a placeholder is the whole point: `JSON.stringify` drops an
 * undefined property, so an unmapped metric simply has no `semanticId` key.
 */
function semanticReference(semanticId?: string | null) {
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
 *   * it must START WITH A LETTER. Prefixing a digit-leading name with `_` -- the obvious fix, and
 *     what this function used to do -- produces an idShort that is still invalid, just differently.
 *     Entirely reachable here: a device called "3-Axis Mill" or "3D Printer 01" is ordinary.
 *   * it is at least TWO characters, so a one-character name needs padding rather than passing
 *     through.
 */
function toIdShort(value: string, fallback: string): string {
  let cleaned = (value || "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  if (!cleaned) return fallback;
  if (!/^[A-Za-z]/.test(cleaned)) cleaned = `Id_${cleaned}`;
  if (cleaned.length < 2) cleaned = `${cleaned}_`;
  return cleaned;
}

function property(
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
function collection(idShort: string, value: unknown[], description?: string) {
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
function file(idShort: string, value: string, contentType: string, description?: string) {
  return {
    modelType: "File",
    idShort,
    contentType,
    value,
    description: description ? [{ language: "en", text: description }] : undefined,
  };
}

/**
 * AAS Part 5 media type for an AASX package. The `+xml` suffix looks wrong for a ZIP and is not --
 * an AASX *is* an Open Packaging Conventions container, and OPC's registered types carry it.
 */
const AASX_MEDIA_TYPE = "application/asset-administration-shell-package+xml";

/** The payload part. Named by the relationship in aasx/_rels/aasx-origin.rels, not by convention. */
const AASX_SPEC_PART = "aasx/aasenv-root.json";

/**
 * Package an AAS Environment as an `.aasx` (OPC / ISO 29500 container).
 *
 * OPC is a ZIP with a mandated discovery chain, and every part of it is load-bearing -- a reader
 * that cannot walk the chain rejects the package rather than guessing:
 *
 *   [Content_Types].xml        declares a media type for every extension in the archive. Omit it
 *                              and the container is not an OPC package at all.
 *   _rels/.rels                package-level relationships. Points at the aasx-origin part.
 *   aasx/aasx-origin           a deliberately EMPTY marker part. It exists purely to be the anchor
 *                              the origin relationship targets, which is how a reader finds the
 *                              AAS content without knowing our file names.
 *   aasx/_rels/aasx-origin.rels  origin-level relationships. Points at the actual payload.
 *   aasx/aasenv-root.json      the Environment, byte-identical to what ?format=json returns.
 *
 * Stored uncompressed (`level: 0`) for [Content_Types].xml is not required by OPC, so everything is
 * simply deflated; readers handle both.
 *
 * SUPPLEMENTARY FILES extend the chain by one more link. A 3D model bundled into the package is a
 * part in its own right, and needs all three of:
 *
 *   an `aas-suppl` relationship FROM THE SPEC PART, not from the origin -- a supplementary file
 *     belongs to the Environment that references it, so its relationship lives in
 *     aasx/_rels/aasenv-root.json.rels;
 *   a [Content_Types] entry for its extension, or the package is malformed (OPC requires every
 *     extension in the archive to be declared, and .glb is not one of the defaults);
 *   a `File.value` rewritten to the part name, since a package-relative reference is the point of
 *     bundling. That rewrite happens in the caller, not here.
 */
type SupplementaryFile = { part: string; bytes: Uint8Array; contentType: string };

function buildAasxPackage(environment: unknown, supplements: SupplementaryFile[] = []): Uint8Array {
  // One Override per supplementary part rather than a Default per extension: two models could
  // share an extension, and an Override names the part exactly. Deduplicated by part name.
  const overrides = supplements
    .map((s) => `  <Override PartName="/${s.part}" ContentType="${s.contentType}"/>`)
    .join("\n");

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="json" ContentType="application/json"/>
  <Override PartName="/aasx/aasx-origin" ContentType="text/plain"/>${overrides ? "\n" + overrides : ""}
</Types>
`;

  const packageRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://admin-shell.io/aasx/relationships/aasx-origin" Target="/aasx/aasx-origin"/>
</Relationships>
`;

  const originRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://admin-shell.io/aasx/relationships/aas-spec" Target="/${AASX_SPEC_PART}"/>
</Relationships>
`;

  const specRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${
    supplements
      .map((s, i) =>
        `  <Relationship Id="rId${i + 100}" Type="http://admin-shell.io/aasx/relationships/aas-suppl" Target="/${s.part}"/>`
      )
      .join("\n")
  }
</Relationships>
`;

  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(packageRels),
    // Empty by design -- see the chain described above.
    "aasx/aasx-origin": strToU8(""),
    "aasx/_rels/aasx-origin.rels": strToU8(originRels),
    [AASX_SPEC_PART]: strToU8(JSON.stringify(environment, null, 2)),
  };

  if (supplements.length > 0) {
    // Only written when there is something to relate. An empty <Relationships/> part is legal but
    // pointless, and its presence would suggest to a reader that supplements were expected.
    entries["aasx/_rels/aasenv-root.json.rels"] = strToU8(specRels);
    for (const s of supplements) entries[s.part] = s.bytes;
  }

  return zipSync(entries);
}

/** The metric names a schema models -- the union of `properties` keys and `required`.
 *  Mirrors modelledMetrics() in frontend/src/utils/deviceTags.js and validate.py. */
function modelledMetrics(definition: Record<string, unknown> | null): string[] {
  if (!definition || typeof definition !== "object") return [];
  const props = definition.properties;
  const required = definition.required;
  const names = new Set<string>();
  if (props && typeof props === "object") {
    for (const key of Object.keys(props as Record<string, unknown>)) names.add(key);
  }
  if (Array.isArray(required)) {
    for (const key of required) if (typeof key === "string") names.add(key);
  }
  return [...names].sort();
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseServiceRoleKey) {
      return json({ error: "Server misconfiguration" }, 500);
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser(token);

    if (userError || !user) {
      return json({ error: "Invalid user token", details: userError?.message }, 401);
    }

    const userRole = await resolveUserRole(supabaseUser, user.id, user.app_metadata?.role || null);
    if (!userRole || !ALLOWED_ROLES.includes(userRole)) {
      return json({ error: "Forbidden: Insufficient privileges" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const { device_id } = body;
    if (!device_id) {
      return json({ error: "Missing required parameter: device_id" }, 400);
    }
    if (!UUID_RE.test(String(device_id))) {
      return json({ error: "device_id must be a device UUID" }, 400);
    }

    // Accepted from either the query string or the body. supabase-js's functions.invoke() sends a
    // body and does not expose the URL, so a body-only parameter would be unreachable from the UI
    // and a query-only one unreachable from curl; supporting both costs one line.
    const requestedFormat = String(
      new URL(req.url).searchParams.get("format") ?? body.format ?? "json",
    ).toLowerCase();

    if (requestedFormat !== "json" && requestedFormat !== "aasx") {
      return json({ error: "format must be 'json' or 'aasx'" }, 400);
    }
    const format = requestedFormat;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const { data: deviceRows, error: deviceError } = await supabaseAdmin
      .from("devices")
      .select("*")
      .eq("id", device_id);

    if (deviceError) return json({ error: deviceError.message }, 500);

    const device = deviceRows?.[0];
    if (!device) return json({ error: "Device not found" }, 404);

    // asset_config is keyed by sparkplug_id, not by the row id -- it is written by ingestion from
    // the DBIRTH payload, which only knows the wire identity.
    //
    // `device_schemas` (migration 0034) is the union of the device_submodels join and the legacy
    // 1:1 devices.schema_id, so this resolves for a device provisioned by either path.
    const [{ data: configRows }, { data: linkRows }, { data: catalogRows }, { data: gatewayRows }] =
      await Promise.all([
        supabaseAdmin.from("asset_config").select("*").eq("asset_id", device.sparkplug_id),
        supabaseAdmin.from("device_schemas").select("schema_id, submodel_key").eq("device_id", device.id),
        supabaseAdmin.from("metric_catalog").select("*"),
        device.gateway_id
          ? supabaseAdmin.from("gateways").select("name,sparkplug_id").eq("id", device.gateway_id)
          : Promise.resolve({ data: [] }),
      ]);

    const links = linkRows ?? [];
    const schemaIds = links.map((l) => l.schema_id).filter(Boolean);
    const { data: schemaRows } = schemaIds.length > 0
      ? await supabaseAdmin.from("schemas").select("*").in("id", schemaIds)
      : { data: [] };

    const schemas = schemaRows ?? [];
    const keyBySchema = new Map<string, string | null>(
      links.map((l) => [String(l.schema_id), (l.submodel_key as string | null) ?? null]),
    );

    const gateway = gatewayRows?.[0] ?? null;
    const config = configRows ?? [];
    const catalog = catalogRows ?? [];

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
    const shellIdShort = toIdShort(device.name, "Device");
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
    // Identity and provenance. Drawn from `devices` plus the birth parameters ingestion recorded;
    // the metrics a nameplate wants (firmware, serial) are published at DBIRTH, not as telemetry.
    const nameplateProps = [
      property("ManufacturerProductDesignation", "xs:string", device.name),
      property("SerialNumber", "xs:string", valueFor("SERIAL_NUMBER")),
      property("FirmwareVersion", "xs:string", valueFor("Controller/FIRMWARE")),
      property("AssetSparkplugId", "xs:string", device.sparkplug_id, {
        description: "Immutable wire identity; the same value keys telemetry in the historian.",
      }),
      property("ConnectionMethod", "xs:string", device.connection_method),
      property("EdgeGatewayName", "xs:string", gateway?.name ?? null),
      property("EdgeGatewaySparkplugId", "xs:string", gateway?.sparkplug_id ?? null),
      property("Status", "xs:string", device.status),
    ];

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

    // ---- One Submodel per attached schema (Phase 5) -------------------------------------------
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
      const modelled = modelledMetrics(schema.schema_definition ?? null);
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
          semanticId: semanticReference(schema.semantic_id ?? null),
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

    const environment = {
      // AAS Part 5 "Environment": the container serialisation, which is what an AASX package holds
      // and what every AAS tool accepts as a JSON drop-in.
      assetAdministrationShells: [
        {
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
        },
      ],
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
    };

    // ---- AASX packaging (Open Packaging Conventions / ISO 29500) ------------------------------
    if (format === "aasx") {
      const filename = `${toIdShort(device.name, "device")}.aasx`;
      const supplements: SupplementaryFile[] = [];
      let bundled3dModel = false;

      // Bundle the model INTO the package rather than leaving a URL in it. Self-containment is the
      // whole reason AASX exists: a package handed to a partner on removable media has to render
      // without reaching back to a host they may have no route to.
      //
      // Best-effort, deliberately. If the object cannot be fetched -- Storage down, object deleted
      // out from under the row -- the export still succeeds with the URL form it would have used
      // anyway. Failing the whole shell because one artefact is unavailable would be the wrong
      // trade: everything else in it is still accurate and useful.
      if (modelPath && modelUrl) {
        try {
          const { data: blob, error: dlError } = await supabaseAdmin.storage
            .from(MODEL_BUCKET)
            .download(modelPath);

          if (dlError || !blob) throw new Error(dlError?.message ?? "empty object");

          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (bytes.byteLength > MAX_BUNDLED_MODEL_BYTES) {
            // Zipping happens in memory in this isolate. Past the cap the reference form is the
            // only one that will not take the worker down with it.
            throw new Error(`model is ${bytes.byteLength} bytes, over the bundling cap`);
          }

          const part = `aasx/files/${modelPath}`;
          supplements.push({ part, bytes, contentType: modelContentType(modelPath) });

          // Rewrite the reference to the part name. This is the ONE element where the packaged
          // Environment deliberately differs from the JSON export: a package-relative path is what
          // makes the bundle self-contained, and is what AAS Part 5 specifies for a supplementary
          // file. The test asserts that this is the only difference.
          for (const submodel of environment.submodels) {
            if ((submodel as { idShort?: string }).idShort !== "VisualRepresentation") continue;
            for (const element of (submodel as { submodelElements: { idShort: string; value: string }[] }).submodelElements) {
              if (element.idShort === "Model3D") element.value = `/${part}`;
            }
          }
          bundled3dModel = true;
        } catch (err) {
          console.warn(
            `[aas-export] not bundling 3D model for ${device.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      return new Response(buildAasxPackage(environment, supplements), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": AASX_MEDIA_TYPE,
          "Content-Disposition": `attachment; filename="${filename}"`,
          // Read by the browser so the UI can report the same counts the JSON path returns in its
          // body -- a binary response has nowhere else to carry them.
          "X-AAS-Stats": JSON.stringify({ ...stats, bundled_3d_model: bundled3dModel }),
          "Access-Control-Expose-Headers": "X-AAS-Stats, Content-Disposition",
        },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        device: { id: device.id, name: device.name, sparkplug_id: device.sparkplug_id },
        // Surfaced rather than hidden: an unmapped metric is a real gap in the export's usefulness,
        // and the caller should be able to see it without diffing the payload.
        stats,
        aas: environment,
      }),
      { status: 200, headers: jsonHeaders },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message || "Internal server error" }, 500);
  }
}

serve(handler);
