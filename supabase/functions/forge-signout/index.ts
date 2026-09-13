import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { serviceRoleClient } from "../_shared/serviceClient.ts";

/**
 * Gitea's own "Sign out" link, made to mean something. Under reverse-proxy authentication Gitea's
 * sign-out clears only its own cookie, and the door signs the person straight back in; routing it
 * to the listener's `/oauth2/signout` alone starts a fresh login that GoTrue auto-approves while
 * the dashboard session is alive. The forge has no session of its own, so signing out of the forge
 * is signing out of the platform: this ends every GoTrue session the caller holds, then sends the
 * browser through the door's sign-out, whose fresh login now meets the dashboard's login page. The
 * mirror of what the dashboard's own sign-out does to the forge (utils/studioSignOut.js). The forge
 * listener forwards the access token on this route so the revocation names the right person; a
 * request with no usable token is still sent through the door's sign-out.
 */

import { corsHeaders } from "../_shared/cors.ts";

function throughTheDoor(): Response {
  return new Response(null, {
    status: 302,
    headers: { ...corsHeaders, Location: "/oauth2/signout", "Cache-Control": "no-store" },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    console.warn("forge-signout: no bearer token to revoke; clearing the door's cookies only");
    return throughTheDoor();
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const token = authHeader.slice("Bearer ".length);

  // Global, deliberately: every session this person holds, the dashboard's included. A local
  // sign-out would end the door's session alone, and the dashboard's would sign them back in.
  const admin = serviceRoleClient(supabaseUrl, serviceKey);
  const { error } = await admin.auth.admin.signOut(token, "global");
  if (error) {
    // Already dead is the ordinary failure here (a sign-out elsewhere first), and it is not a
    // reason to leave the door's cookies in place.
    console.warn(`forge-signout: could not revoke the caller's sessions (${error.message}); clearing the door's cookies anyway`);
  } else {
    console.log("forge-signout: ended every session for the caller");
  }
  return throughTheDoor();
}

serve(handler);
