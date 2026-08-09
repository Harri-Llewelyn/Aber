import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/**
 * Identity + permissions endpoint for Node-RED's adminAuth.
 *
 * WHY THIS EXISTS RATHER THAN USING GoTrue's /oauth/userinfo, OR THE TOKEN'S OWN CLAIMS.
 *
 * GoTrue's OIDC server advertises only standard OIDC claims -- sub, email, email_verified,
 * name, picture, preferred_username and friends. `app_metadata` is not among them, so the role
 * that public.custom_access_token_hook() mirrors into the password-grant access token does not
 * reach an OIDC client at all. And reading `app_metadata.role` from a token the caller already
 * holds would be worse than useless: deleting a user's public.user_roles row IS how a role is
 * revoked, so a claim-based path re-grants the privilege the user held before the revocation
 * for as long as their token lives.
 *
 * public.user_roles is therefore the only source, and the absence of a row means no role.
 *
 * WHY IT IS SEPARATE FROM grafana-userinfo. The two differ in exactly one thing -- the
 * vocabulary they answer in -- but that thing is an authorisation decision. Grafana's client
 * reads `role` (Admin/Editor/Viewer); Node-RED's settings.js reads `permissions` ('*'/'read').
 * Serving both from one endpoint would mean a change made for one product's role model
 * silently moving the other's, on an endpoint whose name mentions only one of them.
 */

import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";

/**
 * Supabase RBAC role -> Node-RED permissions.
 *
 * Node-RED has only '*' and 'read'. Operator and Auditor both map to 'read': neither should be
 * able to deploy a flow, and a Node-RED `function` node executes arbitrary JavaScript inside a
 * container that holds the MQTT credential and can reach Mosquitto, Supabase and TimescaleDB.
 * Deploy authority is therefore the same pair deploy-nodered allows -- Administrator and
 * Shopfloor_Manager -- and for the same reason.
 *
 * The Auditor's actual privilege is over digital_thread in Supabase, enforced by RLS there.
 * Node-RED models nothing equivalent, so there is no tier to distinguish it from Operator.
 */
const PERMISSION_MAP: Record<string, string> = {
  Administrator: "*",
  Shopfloor_Manager: "*",
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
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    // Validate the bearer token by resolving it to a user. This is the authentication step.
    // The token is either the one Node-RED just obtained from /oauth/token during an editor
    // login, or the operator's own access token forwarded by deploy-nodered -- both are signed
    // with the same JWT secret, so an invalid or expired one fails here rather than yielding a
    // default permission.
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
    // "user_roles_select_own_or_privileged": a plain user can read their own row, but the
    // roles(name) join is what actually matters here and reading it through the caller would
    // couple this endpoint to the exact shape of that policy. The user id is already
    // authenticated above, so this is a lookup, not an authorisation decision.
    const supabaseAdmin = createClient(supabaseUrl, serviceKey);
    // A failed lookup is not evidence of a role: resolveUserRole logs and returns null, and
    // returning no permissions lets Node-RED refuse the login — the correct answer to "we could
    // not determine this user's privileges".
    const supabaseRole = await resolveUserRole(supabaseAdmin, user.id);
    const permissions = supabaseRole ? PERMISSION_MAP[supabaseRole] : undefined;

    // Fail closed. Omitting the `permissions` key entirely (rather than guessing 'read') is what
    // lets settings.js refuse the login outright. An unmapped role is a provisioning error and
    // should be visible as one, not silently downgraded to read-only access to the flows.
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
    return jsonResponse(
      { error: "Failed to resolve user info", details: err instanceof Error ? err.message : String(err) },
      500
    );
  }
}

serve(handler);
