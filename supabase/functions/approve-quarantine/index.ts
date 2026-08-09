import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { isUuid } from "./isUuid.ts";
import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";

const ALLOWED_ROLES = ["Administrator", "Shopfloor_Manager"];

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * A 400 describing what the CALLER got wrong.
 *
 * Distinct from the server-side errors below, which deliberately say nothing specific: a
 * validation message is about the request the caller just sent, so it discloses nothing they
 * did not already know, whereas a database error describes the schema.
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
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
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
      device_id, gateway_id, merge_into_device_id, asset_name, cell_id, location_scope
    } = await req.json();

    if (!device_id) {
      return badRequest("Missing required parameter: device_id");
    }

    // Devices are addressed by their UUID primary key. This used to accept either a UUID or a
    // Sparkplug B name, because the quarantine list handed out names; identity now lives on
    // `sparkplug_id` and the list returns UUIDs like every other device view.
    if (!isUuid(device_id)) {
      return badRequest("device_id must be a device UUID");
    }

    // Validated for the same reason device_id is. Previously it was passed straight through to
    // the query, so a malformed value surfaced as a 500 carrying a raw Postgres message rather
    // than as the 400 it actually is.
    if (merge_into_device_id !== undefined && merge_into_device_id !== null) {
      if (!isUuid(merge_into_device_id)) {
        return badRequest("merge_into_device_id must be a device UUID");
      }
      if (merge_into_device_id === device_id) {
        return badRequest("merge_into_device_id must differ from device_id");
      }
    }

    // LOCATION IS OPTIONAL AND OMITTED WHEN NOT ANSWERED, not defaulted.
    //
    // devices.cell_id is NULL-means-inherit with no column default, so a device approved onto a
    // gateway that has a cell needs no answer here -- it inherits, and keeps tracking that
    // gateway. Writing a value the operator did not choose would turn inheritance off
    // permanently for every device approved through this path, which is exactly the failure the
    // column was designed without a default to avoid.
    //
    // An explicitly empty cell_id is still meaningful: it is the picker's "Inherit" option. The
    // `p_set_*` flags below are what carry that distinction into SQL, where a plain NULL
    // argument cannot express "supplied, and cleared" separately from "not supplied".
    const setCell = cell_id !== undefined;
    let normalisedCell: string | null = null;
    if (setCell) {
      const trimmed = typeof cell_id === "string" ? cell_id.trim() : cell_id;
      if (trimmed && !isUuid(trimmed)) {
        return badRequest("cell_id must be a cell UUID");
      }
      normalisedCell = trimmed || null;
    }

    const setLocationScope = location_scope !== undefined;
    if (setLocationScope && location_scope !== "cell" && location_scope !== "site_wide") {
      return badRequest("location_scope must be 'cell' or 'site_wide'");
    }

    if (gateway_id !== undefined && gateway_id !== null && gateway_id !== "" && !isUuid(gateway_id)) {
      return badRequest("gateway_id must be a gateway UUID");
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // ONE ATOMIC CALL, replacing four sequential PostgREST requests.
    //
    // The merge path used to re-key asset_config, update the surviving device, then delete the
    // duplicate -- as three separate round trips with no transaction and no compensating
    // rollback. A failure partway left asset_config pointing at a device that was never merged,
    // or two un-quarantined rows claiming one physical asset. Postgres already gives us
    // atomicity, so the orchestration is gone rather than wrapped in retries.
    //
    // `user.id` is passed explicitly because log_digital_thread_event() records auth.uid(), and
    // this client authenticates as service_role, whose JWT carries no `sub`. Every approval and
    // every merge was therefore logged with changed_by = NULL -- the audit trail could not say
    // who admitted a device to the network. The RPC sets the actor for the transaction, and
    // re-checks their role against public.user_roles so authorization does not rest solely on
    // the check above.
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
    });

    if (rpcError) {
      // Map the RPC's own SQLSTATEs onto honest HTTP codes, and do not relay the driver's
      // message. A raw Postgres error discloses table, column and constraint names to whoever
      // can reach the endpoint; the codes below are the ones this RPC raises deliberately.
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
