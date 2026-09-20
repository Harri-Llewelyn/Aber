/**
 * AAS export: emit an Asset Administration Shell (IEC 63278) V3 document for one device, as JSON,
 * as an `.aasx` package, or as a `bundle` -- the same `.aasx` with the device's digital thread, the
 * telemetry still in the live historian and a manifest naming the cold objects added as
 * supplementary parts, stored beside the cold tier and recorded in `asset_exports`. An adapter,
 * not a migration: the database keeps its own shape and this projects it on the way out. The
 * mapping lives in `../_shared/aas/shell.ts`, shared with `aas-api` so the two cannot describe the
 * same machine differently, and the bundle's parts in `../_shared/aas/bundle.ts`; what remains
 * here is the role ladder, the OPC packaging, and what to do when a bundled model cannot be
 * reached. The caller's JWT resolves their role, and the service-role client is used only after
 * that check; `aas-api` deliberately does not hold that key.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { serviceRoleClient } from "../_shared/serviceClient.ts";
import { zipSync, strToU8 } from "https://esm.sh/fflate@0.8.2";
import { modelContentType } from "../_shared/aas/model3dContentType.ts";
import {
  BUNDLE_PARTS,
  DEFAULT_MAX_TELEMETRY_ROWS,
  DEFAULT_MAX_THREAD_ROWS,
  EXPORT_BUCKET,
  EXPORT_CONTENT_TYPE,
  HOURLY_COLUMNS,
  RAW_COLUMNS,
  boundedInt,
  buildBundleManifest,
  csvOf,
  exportObjectKey,
  loadColdObjects,
  loadHorizons,
  loadTelemetry,
  loadThread,
  sha256Hex,
} from "../_shared/aas/bundle.ts";
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

// Read access, wider than approve-quarantine's write access: Operator and Auditor are the roles
// that hand a shell to a partner. Still an allow-list, so an unmapped role is refused.
const ALLOWED_ROLES = ["Administrator", "Shopfloor_Manager", "Operator", "Auditor"];

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: jsonHeaders });

/**
 * AAS Part 5 media type for an AASX package. The `+xml` suffix is correct: an AASX is an Open
 * Packaging Conventions container, and OPC's registered types carry it.
 */
const AASX_MEDIA_TYPE = "application/asset-administration-shell-package+xml";

/** The payload part. Named by the relationship in aasx/_rels/aasx-origin.rels, not by convention. */
const AASX_SPEC_PART = "aasx/aasenv-root.json";

/**
 * Package an AAS Environment as an `.aasx` (OPC / ISO 29500 container). OPC is a ZIP with a
 * mandated discovery chain, every part of which a reader requires: `[Content_Types].xml` declares a
 * media type for every extension; `_rels/.rels` points at the aasx-origin part; `aasx/aasx-origin`
 * is an empty marker the origin relationship targets; `aasx/_rels/aasx-origin.rels` points at the
 * payload; `aasx/aasenv-root.json` is the Environment, byte-identical to the JSON export. A bundled
 * 3D model needs an `aas-suppl` relationship from the spec part (aasx/_rels/aasenv-root.json.rels),
 * a [Content_Types] entry for its extension, and a `File.value` rewritten to the part name, which
 * the caller does.
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

    // Accepted from either the query string or the body: supabase-js's functions.invoke() sends a
    // body and does not expose the URL, and curl the reverse.
    const requestedFormat = String(
      new URL(req.url).searchParams.get("format") ?? body.format ?? "json",
    ).toLowerCase();

    if (requestedFormat !== "json" && requestedFormat !== "aasx" && requestedFormat !== "bundle") {
      return json({ error: "format must be 'json', 'aasx' or 'bundle'" }, 400);
    }
    const format = requestedFormat;

    const supabaseAdmin = serviceRoleClient(supabaseUrl, supabaseServiceRoleKey);

    const record = await loadDeviceRecord(supabaseAdmin, String(device_id));
    if (!record) return json({ error: "Device not found" }, 404);

    const { device } = record;
    const { environment, stats, modelPath, modelUrl } = buildEnvironment(record);

    // ---- AASX packaging (Open Packaging Conventions / ISO 29500) ------------------------------
    // A bundle is an AASX with more supplements, so it takes this branch and adds its parts below.
    if (format === "aasx" || format === "bundle") {
      const idShort = toIdShort(String(device.name ?? ""), "device");
      const filename = format === "bundle" ? `${idShort}-bundle.aasx` : `${idShort}.aasx`;
      const supplements: SupplementaryFile[] = [];
      let bundled3dModel = false;

      // Bundle the model into the package rather than leaving a URL in it: self-containment is the
      // reason AASX exists. Best-effort: if the object cannot be fetched, the export still succeeds
      // with the URL form.
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

          // Rewrite the reference to the part name. This is the one element where the packaged
          // Environment differs from the JSON export, as AAS Part 5 specifies for a supplementary
          // file; the test asserts it is the only difference.
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

      // Refuse to ship a package whose only model reference is unreachable: bundling did not happen
      // and the URL fallback points at loopback, so the AASX would validate and claim a
      // VisualRepresentation that resolves on no other machine. Failing loudly is right here and
      // not in the JSON path, because self-containment is the reason to produce an AASX. This
      // cannot fire on the ordinary local path, where a model small enough to bundle is bundled.
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

      if (format === "aasx") {
        return new Response(buildAasxPackage(environment, supplements), {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": AASX_MEDIA_TYPE,
            "Content-Disposition": `attachment; filename="${filename}"`,
            // Read by the browser so the UI can report the same counts the JSON path returns in
            // its body -- a binary response has nowhere else to carry them.
            "X-AAS-Stats": JSON.stringify({ ...stats, bundled_3d_model: bundled3dModel }),
            "Access-Control-Expose-Headers": "X-AAS-Stats, Content-Disposition",
          },
        });
      }

      // ---- The bundle: the parts, the manifest, the stored copy ------------------------------
      const takenAt = new Date().toISOString();
      const caps = {
        telemetry: boundedInt(Deno.env.get("ASSET_EXPORT_MAX_TELEMETRY_ROWS"), DEFAULT_MAX_TELEMETRY_ROWS),
        thread: boundedInt(Deno.env.get("ASSET_EXPORT_MAX_THREAD_ROWS"), DEFAULT_MAX_THREAD_ROWS),
      };
      const sparkplugId = String(device.sparkplug_id ?? "");

      // One historian scan at a time: concurrent range scans over the FDW are the load pattern
      // the telemetry export dialog avoids too. The thread and the horizons are the platform's
      // own tables and run together.
      const raw = await loadTelemetry(supabaseAdmin, "telemetry", sparkplugId, caps.telemetry);
      const hourly = await loadTelemetry(supabaseAdmin, "telemetry_1h", sparkplugId, caps.telemetry);
      const [thread, horizons] = await Promise.all([
        loadThread(supabaseAdmin, String(device.id), caps.thread),
        loadHorizons(supabaseAdmin).catch((err) => {
          console.warn(`[aas-export] horizons unavailable for the bundle: ${err instanceof Error ? err.message : String(err)}`);
          return {} as Record<string, string | null>;
        }),
      ]);
      // As the caller, so the manifest lists what this person may know exists.
      const cold = await loadColdObjects(supabaseUser, (device.created_at as string | null) ?? null, takenAt);

      const manifest = buildBundleManifest({
        takenAt,
        takenBy: { id: user.id, email: user.email ?? null },
        device,
        gateway: record.gateway,
        caps,
        raw,
        hourly,
        thread,
        horizons,
        cold,
        bundled3dModel,
      });

      // Oldest first in the files, as a history reads; the loaders page newest first so a cap
      // keeps the most recent rows.
      supplements.push(
        { part: BUNDLE_PARTS.thread, bytes: strToU8(JSON.stringify(thread.rows, null, 2)), contentType: "application/json" },
        { part: BUNDLE_PARTS.raw, bytes: strToU8(csvOf([...raw.rows].reverse(), RAW_COLUMNS)), contentType: "text/csv" },
        { part: BUNDLE_PARTS.hourly, bytes: strToU8(csvOf([...hourly.rows].reverse(), HOURLY_COLUMNS)), contentType: "text/csv" },
        { part: BUNDLE_PARTS.manifest, bytes: strToU8(JSON.stringify(manifest, null, 2)), contentType: "application/json" },
      );
      const bytes = buildAasxPackage(environment, supplements);

      // The stored copy is what a tombstone can point at once the row is gone; the download is
      // what the caller asked for. A failure to store is reported in the header and the download
      // still happens -- the caller holds the only copy then, and the stats say so.
      const objectKey = exportObjectKey(sparkplugId || String(device.id), takenAt);
      const stored: Record<string, unknown> = {
        bucket: EXPORT_BUCKET, object_key: objectKey, stored: false,
      };
      const bundleStats = {
        raw_rows: raw.rows.length,
        hourly_rows: hourly.rows.length,
        thread_rows: thread.rows.length,
        cold_objects: cold.objects.length,
        truncated: raw.truncated || hourly.truncated || thread.truncated,
        not_included: manifest.not_included,
      };
      try {
        const digest = await sha256Hex(bytes);
        const { error: uploadError } = await supabaseAdmin.storage
          .from(EXPORT_BUCKET)
          .upload(objectKey, bytes, { contentType: EXPORT_CONTENT_TYPE, upsert: false });
        if (uploadError) throw new Error(uploadError.message);

        const { data: row, error: rowError } = await supabaseAdmin
          .from("asset_exports")
          .insert({
            entity_type: "devices",
            entity_id: device.id,
            name: device.name,
            sparkplug_id: sparkplugId || null,
            format: "aasx",
            object_bucket: EXPORT_BUCKET,
            object_key: objectKey,
            object_bytes: bytes.byteLength,
            sha256: digest,
            stats: bundleStats,
            taken_at: takenAt,
            taken_by: user.id,
            taken_by_email: user.email ?? null,
          })
          .select("id")
          .single();
        if (rowError) throw new Error(rowError.message);

        stored.stored = true;
        stored.export_id = row.id;
        stored.sha256 = digest;
      } catch (err) {
        stored.reason = err instanceof Error ? err.message : String(err);
        console.error(`[aas-export] bundle for ${device.id} was not stored: ${stored.reason}`);
      }

      return new Response(bytes, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": AASX_MEDIA_TYPE,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "X-AAS-Stats": JSON.stringify({
            ...stats,
            bundled_3d_model: bundled3dModel,
            bundle: { ...bundleStats, ...stored, taken_at: takenAt },
          }),
          "Access-Control-Expose-Headers": "X-AAS-Stats, Content-Disposition",
        },
      });
    }

    /* A JSON shell carrying a loopback model URL is still a valid shell, so this warns rather than
       refuses, unlike the AASX branch above. It fires on the URL actually emitted: a device with no
       model has no reference to be unreachable. */
    const modelUrlIsUnreachable = Boolean(device.model_3d_path) && MODEL_BASE_IS_LOOPBACK;

    return new Response(
      JSON.stringify({
        success: true,
        device: { id: device.id, name: device.name, sparkplug_id: device.sparkplug_id },
        // Surfaced rather than hidden: an unmapped metric is a real gap in the export's usefulness,
        // and the caller should be able to see it without diffing the payload.
        stats,
        // Present only when there is something to warn about, so a caller can test for the key.
        ...(modelUrlIsUnreachable
          ? {
            warning:
              "This shell's 3D model reference points at this host and will not resolve for " +
              "anyone else. " + MODEL_BASE_ADVICE,
          }
          : {}),
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
