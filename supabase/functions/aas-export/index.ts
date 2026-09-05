/**
 * AAS export: emit an Asset Administration Shell (IEC 63278) V3 document for one device, as JSON
 * or as an `.aasx` package.
 *
 * An *adapter*, not a migration: the database keeps its own shape and this function projects it
 * into AAS on the way out. Nothing upstream knows AAS exists. Archived migration 0029's header records why
 * a native AAS metamodel was rejected (recursive RLS, a third identifier namespace, a fourth type
 * system).
 *
 * THE MAPPING ITSELF NO LONGER LIVES HERE. It moved to `../_shared/aas/shell.ts` when `aas-api`
 * began serving the same object graph over the IDTA 02001/02002 REST surface. Two constructions of
 * one shell would eventually disagree, and the disagreement would be invisible: the `.aasx` a
 * customer holds and the endpoint their ERP queries would describe the same machine differently,
 * both reporting success. What remains here is what is genuinely export-only -- the role ladder,
 * the OPC packaging, and the decision about what to do when a bundled model cannot be reached.
 *
 * The three emission rules that shape the document (telemetry linked rather than inlined, an
 * unmapped semanticId omitted rather than emptied, one Submodel per attached schema) are stated
 * and enforced in the shared module, beside the code that applies them.
 *
 * SECURITY. The caller's own JWT resolves their role; the service-role client is used only after
 * that check passes. Broader disclosure than any single table it reads -- a shell aggregates
 * nameplate, configuration and documentation into one payload. `aas-api` deliberately does NOT
 * hold that key: see its header for why a live REST surface must read as the caller.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { zipSync, strToU8 } from "https://esm.sh/fflate@0.8.2";
import { modelContentType } from "../_shared/aas/model3dContentType.ts";
import {
  buildEnvironment,
  loadDeviceRecord,
  MAX_BUNDLED_MODEL_BYTES,
  MODEL_BASE_ADVICE,
  MODEL_BASE_IS_LOOPBACK,
  MODEL_BUCKET,
  toIdShort,
  UUID_RE,
} from "../_shared/aas/shell.ts";
import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

// Read access, deliberately wider than approve-quarantine's write access: an export is a read, and
// Operator/Auditor are the roles that would actually need to hand a shell to a partner. Still an
// allow-list, so an unmapped role is refused rather than defaulted.
const ALLOWED_ROLES = ["Administrator", "Shopfloor_Manager", "Operator", "Auditor"];

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: jsonHeaders });

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
    const supabaseAnonKey = gatewayKey();
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

    const userRole = await resolveUserRole(supabaseUser, user.id);
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

    const record = await loadDeviceRecord(supabaseAdmin, String(device_id));
    if (!record) return json({ error: "Device not found" }, 404);

    const { device } = record;
    const { environment, stats, modelPath, modelUrl } = buildEnvironment(record);

    // ---- AASX packaging (Open Packaging Conventions / ISO 29500) ------------------------------
    if (format === "aasx") {
      const filename = `${toIdShort(String(device.name ?? ""), "device")}.aasx`;
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
          for (const submodel of environment.submodels as { idShort?: string }[]) {
            if (submodel.idShort !== "VisualRepresentation") continue;
            for (const element of (submodel as unknown as { submodelElements: { idShort: string; value: string }[] }).submodelElements) {
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

      // REFUSE TO SHIP A PACKAGE WHOSE ONLY MODEL REFERENCE IS UNREACHABLE.
      //
      // This is the degraded path and nothing else: the device has a model, bundling did not
      // happen (over the size cap, Storage unavailable, object deleted), so the package falls back
      // to the URL form -- and that URL points at loopback. The result is an AASX that opens
      // cleanly, validates, claims a VisualRepresentation, and whose one File element resolves to
      // nothing on any machine but this one. Nobody downstream can tell that from a working
      // package until they try to render it.
      //
      // Failing loudly is the right trade HERE and not in the JSON path, because self-containment
      // is the entire reason to produce an AASX rather than a JSON environment. A package that
      // silently is not self-contained is worse than no package.
      //
      // It cannot fire on the ordinary local path: a model small enough to bundle IS bundled, and
      // a device with no model never reaches this branch. Reaching it means something is already
      // wrong and this says which thing.
      if (modelPath && !bundled3dModel && MODEL_BASE_IS_LOOPBACK) {
        console.error(`[aas-export] refusing to package an unreachable model URL. ${MODEL_BASE_ADVICE}`);
        return json({
          error:
            "The 3D model could not be bundled into the package, and the URL it would fall back " +
            "to is not reachable from anywhere but this host -- the resulting AASX would claim a " +
            "visual representation it cannot deliver. " + MODEL_BASE_ADVICE,
          hint:
            "Alternatively reduce the model below AAS_MAX_BUNDLED_MODEL_BYTES (currently " +
            `${MAX_BUNDLED_MODEL_BYTES} bytes) so it is bundled into the package and no URL is ` +
            "needed at all, which is the self-contained form AASX exists for.",
        }, 500);
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
