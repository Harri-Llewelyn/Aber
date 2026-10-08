/**
 * Whether the caller is an Administrator now: the studio listener's `ext_authz` step
 * (supabase/envoy.yaml). The listener has already verified the token and admitted its role claim;
 * this reads `user_roles` on every request, so a person whose access was removed or whose role
 * changed since the token was signed is refused on their next request, as at the forge's door.
 *
 * Answers: 200, an Administrator; 403, any other role or none; 302 to the door's /oauth2/signout
 * when the token verifies but GoTrue refuses it (signed out, banned, a password set since), which
 * clears the cookies and starts a fresh login; 503 when GoTrue or the role lookup cannot answer,
 * and the listener's failure_mode_allow then admits on the claim it already checked, so a broken
 * edge runtime or API does not also take away the console. The identity is always the token's sub.
 */

import { createClient, isAuthRetryableFetchError } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";
import { serverError } from "../_shared/failure.ts";
import { lookUpUserRole } from "../_shared/roles.ts";
import { serviceRoleClient } from "../_shared/serviceClient.ts";

const FN = "studio-admission";

/** The door's own sign-out path, which Envoy's oauth2 filter serves. */
export const SIGNOUT_PATH = "/oauth2/signout";

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...headers },
  });
}

export async function handler(req: Request): Promise<Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Missing Authorization header" }, 401);
  }
  const token = authHeader.slice("Bearer ".length);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";

  // Verified again against GoTrue, not the shared secret: only GoTrue knows the session has gone.
  const asCaller = createClient(supabaseUrl, gatewayKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userError } = await asCaller.auth.getUser(token);
  if (userError && (isAuthRetryableFetchError(userError) || (userError.status ?? 0) >= 500)) {
    return serverError(req, FN, userError, {
      status: 503,
      error: "Could not verify the caller's session",
      context: "GoTrue did not answer the session check",
    });
  }
  if (userError || !user) {
    // Envoy forwards a denied answer's status and Location, so the browser leaves through the door.
    return json({ error: "Session ended", next: SIGNOUT_PATH }, 302, { Location: SIGNOUT_PATH });
  }

  let role: string | null;
  try {
    const asService = serviceRoleClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    role = await lookUpUserRole(asService, user.id);
  } catch (err) {
    return serverError(req, FN, err, {
      status: 503,
      error: "Could not resolve the caller's role",
      context: `role lookup for ${user.id}`,
    });
  }

  if (role !== "Administrator") {
    console.warn(`${FN}: ${user.id} holds role '${role ?? "none"}'; Studio refused`);
    return json({ error: `Role '${role ?? "none"}' does not open Studio` }, 403);
  }
  return json({ sub: user.id, role }, 200);
}
