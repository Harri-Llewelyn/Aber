import { createClient } from "@supabase/supabase-js";
import { serviceRoleClient } from "../_shared/serviceClient.ts";

/**
 * Identity and permissions endpoint for Node-RED's adminAuth. GoTrue's OIDC server advertises only
 * standard claims, so the role in `app_metadata` does not reach an OIDC client, and reading it from
 * the token would re-grant a revoked role for as long as the token lives. public.user_roles is the
 * only source, and an absent row means no role. Separate from grafana-userinfo because the
 * vocabulary each answers in is an authorisation decision: Grafana reads `role`, Node-RED's
 * settings.js reads `permissions`.
 */

import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";
import { serverError } from "../_shared/failure.ts";

/**
 * Supabase RBAC role to Node-RED permissions. Node-RED has only '*' and 'read', and everything
 * below Administrator maps to 'read': a `function` node executes arbitrary JavaScript in a
 * container that holds the MQTT credential. This map is deploy authority, not "who may look at the
 * flows": a manager keeps 'read', so the editor still opens. Auditor and Operator cannot be
 * distinguished in Node-RED's model.
 */
const PERMISSION_MAP: Record<string, string> = {
  Administrator: "*",
  Shopfloor_Manager: "read",
  Operator: "read",
  Auditor: "read",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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
    const anonKey = gatewayKey();
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    // Validate the bearer token by resolving it to a user. This is the authentication step: an
    // invalid or expired token fails here rather than yielding a default permission.
    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser(token);

    if (userError || !user) {
      return jsonResponse(
        { error: "Invalid user token", details: userError?.message },
        401
      );
    }

    // Read the role with the service key, not the caller's token: the user id is already
    // authenticated above, so this is a lookup rather than an authorisation decision.
    const supabaseAdmin = serviceRoleClient(supabaseUrl, serviceKey);
    // A failed lookup is not evidence of a role: returning no permissions lets Node-RED refuse the
    // login.
    const supabaseRole = await resolveUserRole(supabaseAdmin, user.id);
    const permissions = supabaseRole ? PERMISSION_MAP[supabaseRole] : undefined;

    // Fail closed: omitting the `permissions` key entirely, rather than guessing 'read', is what
    // lets settings.js refuse the login. An unmapped role is a provisioning error.
    const body: Record<string, unknown> = {
      sub: user.id,
      email: user.email,
      email_verified: Boolean(user.email_confirmed_at),
      name: user.email,
      preferred_username: user.email,
      supabase_role: supabaseRole,
    };
    if (permissions) body.permissions = permissions;

    return jsonResponse(body, 200);
  } catch (err) {
    return serverError(req, "nodered-userinfo", err, { error: "Failed to resolve user info" });
  }
}

Deno.serve(handler);
