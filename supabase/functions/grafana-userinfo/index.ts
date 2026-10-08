import { createClient } from "@supabase/supabase-js";
import { serviceRoleClient } from "../_shared/serviceClient.ts";

/**
 * OIDC userinfo endpoint for Grafana's [auth.generic_oauth] `api_url`. GoTrue's OIDC server
 * advertises only standard claims, so the role in `app_metadata` does not reach an OIDC client and
 * Grafana's role_attribute_path would have nothing to read. This returns the standard identity
 * claims plus `role`, read from public.user_roles, so a role change takes effect on the next
 * Grafana login.
 */

import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";
import { serverError } from "../_shared/failure.ts";

/**
 * Supabase RBAC role to Grafana org role. Operator and Auditor both map to Viewer: Grafana has no
 * read-only-plus-audit tier, and the Auditor's privilege is over audit_trail in Supabase.
 */
const ROLE_MAP: Record<string, string> = {
  Administrator: "Admin",
  Shopfloor_Manager: "Editor",
  Operator: "Viewer",
  Auditor: "Viewer",
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
    // invalid or expired token fails here rather than yielding a default role.
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
    // authenticated above, so this is a lookup rather than an authorisation decision, and reading
    // through the caller would couple this endpoint to the shape of the user_roles policy.
    const supabaseAdmin = serviceRoleClient(supabaseUrl, serviceKey);
    // A failed lookup is not evidence of a role: returning no role lets Grafana's
    // role_attribute_strict refuse the login.
    const dbRole = await resolveUserRole(supabaseAdmin, user.id);
    // public.user_roles is the only source, and an absent row means no role. A fallback to the
    // JWT's app_metadata.role would re-grant a revoked privilege at every login.
    const supabaseRole = dbRole ?? null;
    const grafanaRole = supabaseRole ? ROLE_MAP[supabaseRole] : undefined;

    // Fail closed: returning no `role` key at all, rather than guessing Viewer, is what lets
    // role_attribute_strict = true reject the login. An unmapped role is a provisioning error.
    const body: Record<string, unknown> = {
      sub: user.id,
      email: user.email,
      email_verified: Boolean(user.email_confirmed_at),
      name: user.email,
      preferred_username: user.email,
      supabase_role: supabaseRole,
    };
    if (grafanaRole) body.role = grafanaRole;

    return jsonResponse(body, 200);
  } catch (err) {
    return serverError(req, "grafana-userinfo", err, { error: "Failed to resolve user info" });
  }
}

Deno.serve(handler);
