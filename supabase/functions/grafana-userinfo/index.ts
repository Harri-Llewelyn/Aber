import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/**
 * OIDC userinfo endpoint for Grafana's [auth.generic_oauth] `api_url`.
 *
 * WHY THIS EXISTS RATHER THAN USING GoTrue's /oauth/userinfo.
 *
 * GoTrue's OIDC server advertises only standard OIDC claims -- sub, email, email_verified,
 * name, picture, preferred_username and friends. `app_metadata` is not among them, so the
 * role that public.custom_access_token_hook() mirrors into the password-grant access token
 * does not reach an OIDC client. Grafana's role_attribute_path would have nothing to read:
 * with role_attribute_strict = true every user is denied, and with it false every user
 * silently becomes a Viewer. Neither is the intended mapping.
 *
 * This endpoint returns the standard identity claims PLUS `role`, read from public.user_roles
 * -- the same RBAC tables the dashboard and the RLS policies use. Sourcing from the database
 * rather than a token claim also means a role change takes effect on the user's next Grafana
 * login instead of whenever their JWT happens to be reissued.
 */

import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";

/**
 * Supabase RBAC role -> Grafana org role.
 *
 * Grafana only has Admin / Editor / Viewer. Operator and Auditor both map to Viewer: neither
 * should be able to edit dashboards, and Grafana has no read-only-plus-audit tier to
 * distinguish them. The Auditor's actual privilege is over digital_thread in Supabase, which
 * is enforced by RLS there and is not something Grafana models.
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

    // Validate the bearer token by resolving it to a user. This is the authentication step --
    // the token is the one Grafana just obtained from /oauth/token, signed with the same JWT
    // secret, so an invalid or expired token fails here rather than yielding a default role.
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

    // Read the role with the service key, not the caller's token. user_roles is protected by
    // "user_roles_select_own_or_privileged" (migration 0004): a plain user can read their own
    // row, but the roles(name) join is what actually matters here and reading it through the
    // caller would couple this endpoint to the exact shape of that policy. The user id is
    // already authenticated above, so this is a lookup, not an authorisation decision.
    const supabaseAdmin = createClient(supabaseUrl, serviceKey);
    // A failed lookup is not evidence of a role: resolveUserRole logs and returns null, and
    // returning no role lets Grafana's role_attribute_strict refuse the login — the correct
    // answer to "we could not determine this user's privileges".
    const dbRole = await resolveUserRole(supabaseAdmin, user.id);
    // public.user_roles is the ONLY source. This used to fall back to the JWT's
    // app_metadata.role when no row was found, on the reasoning that handle_new_user() writes
    // both -- but deleting the row is exactly how a role is revoked, so the fallback re-granted
    // the privilege the user held before the revocation and kept granting it at every
    // subsequent Grafana login. An absent row means no role.
    const supabaseRole = dbRole ?? null;
    const grafanaRole = supabaseRole ? ROLE_MAP[supabaseRole] : undefined;

    // Fail closed. Returning no `role` key at all (rather than guessing "Viewer") is what lets
    // Grafana's role_attribute_strict = true reject the login. An unmapped role is a
    // provisioning error and should be visible as one, not silently downgraded to read-only.
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
    return jsonResponse(
      { error: "Failed to resolve user info", details: err instanceof Error ? err.message : String(err) },
      500
    );
  }
}

serve(handler);
