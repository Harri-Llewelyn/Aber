import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { serviceRoleClient } from "../_shared/serviceClient.ts";
import { isUuid } from "./isUuid.ts";
import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";

const ALLOWED_ROLES = ["Administrator", "Shopfloor_Manager"];

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * A 400 describing what the caller got wrong. A validation message discloses nothing they did not
 * already know, whereas a database error describes the schema.
 */
function badRequest(message: string): Response {
  return jsonResponse({ error: message }, 400);
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing Authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = gatewayKey();
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseServiceRoleKey) {
      return jsonResponse({ error: "Server misconfiguration" }, 500);
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser(token);

    if (userError || !user) {
      return jsonResponse({ error: "Invalid user token", details: userError?.message }, 401);
    }

    const userRole = await resolveUserRole(supabaseUser, user.id);

    if (!userRole || !ALLOWED_ROLES.includes(userRole)) {
      return jsonResponse({ error: "Forbidden: Insufficient privileges" }, 403);
    }


    const {
      device_id, gateway_id, merge_into_device_id, asset_name, cell_id, area_id, location_scope
    } = await req.json();

    if (!device_id) {
      return badRequest("Missing required parameter: device_id");
    }

    // Devices are addressed by their UUID primary key; the quarantine list returns UUIDs like every
    // other device view.
    if (!isUuid(device_id)) {
      return badRequest("device_id must be a device UUID");
    }

    // Validated for the same reason device_id is, so a malformed value is a 400 rather than a 500
    // carrying a raw Postgres message.
    if (merge_into_device_id !== undefined && merge_into_device_id !== null) {
      if (!isUuid(merge_into_device_id)) {
        return badRequest("merge_into_device_id must be a device UUID");
      }
      if (merge_into_device_id === device_id) {
        return badRequest("merge_into_device_id must differ from device_id");
      }
    }

    // Location is optional and omitted when not answered, not defaulted: devices.cell_id is
    // NULL-means-inherit with no column default, and writing a value the operator did not choose
    // would turn inheritance off for every device approved here. An explicitly empty cell_id is the
    // picker's Inherit option; the `p_set_*` flags carry the distinction between
    // supplied-and-cleared and not-supplied into SQL.
    const setCell = cell_id !== undefined;
    let normalisedCell: string | null = null;
    if (setCell) {
      const trimmed = typeof cell_id === "string" ? cell_id.trim() : cell_id;
      if (trimmed && !isUuid(trimmed)) {
        return badRequest("cell_id must be a cell UUID");
      }
      normalisedCell = trimmed || null;
    }

    // The area, under the same absent-or-empty rule as the cell. Only area_wide stores one
    // (`devices_area_wide_names_its_area`), and it must.
    const setArea = area_id !== undefined;
    let normalisedArea: string | null = null;
    if (setArea) {
      const trimmed = typeof area_id === "string" ? area_id.trim() : area_id;
      if (trimmed && !isUuid(trimmed)) {
        return badRequest("area_id must be an area UUID");
      }
      normalisedArea = trimmed || null;
    }

    const setLocationScope = location_scope !== undefined;
    if (setLocationScope && location_scope !== "cell" && location_scope !== "site_wide" && location_scope !== "area_wide") {
      return badRequest("location_scope must be 'cell', 'area_wide' or 'site_wide'");
    }
    if (setLocationScope && location_scope === "area_wide" && !normalisedArea) {
      return badRequest("area_id is required when location_scope is 'area_wide'");
    }

    if (gateway_id !== undefined && gateway_id !== null && gateway_id !== "" && !isUuid(gateway_id)) {
      return badRequest("gateway_id must be a gateway UUID");
    }

    const supabaseAdmin = serviceRoleClient(supabaseUrl, supabaseServiceRoleKey);

    // One atomic call. The RPC re-keys asset_config, updates the surviving device and deletes the
    // duplicate in one transaction. `user.id` is passed explicitly because
    // log_digital_thread_event() records auth.uid(), and this client authenticates as service_role,
    // whose JWT carries no `sub`; the RPC sets the actor and re-checks their role against
    // public.user_roles.
    const { data, error: rpcError } = await supabaseAdmin.rpc("approve_quarantined_device", {
      p_device_id: device_id,
      p_actor_id: user.id,
      p_gateway_id: gateway_id || null,
      p_merge_into_device_id: merge_into_device_id || null,
      p_asset_name: typeof asset_name === "string" ? asset_name : null,
      p_cell_id: normalisedCell,
      p_location_scope: setLocationScope ? location_scope : null,
      p_set_cell: setCell,
      p_set_location_scope: setLocationScope,
      p_area_id: normalisedArea,
      p_set_area: setArea,
    });

    if (rpcError) {
      // Map the RPC's own SQLSTATEs onto HTTP codes, and do not relay the driver's message, which
      // discloses table, column and constraint names.
      const status = rpcError.code === "P0002" || rpcError.code === "no_data_found"
        ? 404
        : rpcError.code === "42501"
        ? 403
        : rpcError.code === "22023"
        ? 400
        : 500;

      console.error(
        `approve_quarantined_device failed for device ${device_id} ` +
          `(actor ${user.id}, code ${rpcError.code}): ${rpcError.message}`
      );

      return jsonResponse(
        {
          error: status === 404
            ? "Device not found"
            : status === 403
            ? "Forbidden: Insufficient privileges"
            : status === 400
            ? "Invalid approval request"
            : "Approval failed",
        },
        status
      );
    }

    return jsonResponse({ success: true, data }, 200);
  } catch (err) {
    // The caller gets a generic message; the detail goes to the function log, where an operator
    // can see it and an anonymous caller cannot.
    console.error(`approve-quarantine unhandled error: ${err instanceof Error ? err.stack : String(err)}`);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
}

serve(handler);
