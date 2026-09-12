import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";

/**
 * What the broker holds, read live for the Access Control page: every account with its roles and
 * whether it is disabled, and every role with its rules. The credential service reads it from the
 * Dynamic Security plugin (`listClients`, `listRoles`) and returns no hash material; this function
 * forwards that read to a signed-in Administrator and nobody else.
 *
 * Administrator only, narrower than issuing (which admits Shopfloor_Manager): the inventory names
 * every account on the broker, including the platform principals and the plugin's admin, which is
 * the map of the site's telemetry authority. No service-role key and no database write: the role
 * check is the whole decision, made here because there is no RPC behind it to make it again.
 */

const ALLOWED_ROLES = ["Administrator"];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return json(405, { error: "Method not allowed", details: "Use GET." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = gatewayKey();
  const credentialUrl = Deno.env.get("MQTT_CREDENTIAL_SERVICE_URL") ?? "";
  const credentialToken = Deno.env.get("MQTT_CREDENTIAL_SERVICE_TOKEN") ?? "";

  const missing = [
    !supabaseUrl && "SUPABASE_URL",
    !anonKey && "SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY",
    !credentialUrl && "MQTT_CREDENTIAL_SERVICE_URL",
    !credentialToken && "MQTT_CREDENTIAL_SERVICE_TOKEN",
  ].filter(Boolean);

  if (missing.length > 0) {
    console.error(`broker-inventory: missing ${missing.join(", ")}`);
    return json(500, {
      error: "The broker inventory is not configured",
      details: `The server is missing: ${missing.join(", ")}.`,
    });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json(401, { error: "Unauthorized", details: "A signed-in session is required." });
  }

  // As the caller: the role lookup applies RLS on `user_roles`, and a caller whose row was deleted
  // reads as no role and is refused.
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await supabase.auth
    .getUser(authHeader.replace("Bearer ", ""));
  if (userError || !user) {
    return json(401, { error: "Invalid user token", details: userError?.message });
  }

  const userRole = await resolveUserRole(supabase, user.id);
  if (!userRole || !ALLOWED_ROLES.includes(userRole)) {
    return json(403, {
      error: "Forbidden: Insufficient privileges",
      details: "Reading the broker's accounts requires Administrator.",
    });
  }

  try {
    const response = await fetch(`${credentialUrl.replace(/\/+$/, "")}/clients`, {
      headers: { Authorization: `Bearer ${credentialToken}` },
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      console.error(`credential service answered ${response.status}: ${detail}`);
      return json(503, {
        error: "Could not read the broker",
        details: "The broker credential service could not read the broker's accounts.",
      });
    }

    return json(200, await response.json());
  } catch (err) {
    console.error(`credential service unreachable: ${err instanceof Error ? err.message : err}`);
    return json(503, {
      error: "Could not read the broker",
      details: "The broker credential service is unreachable.",
    });
  }
});
