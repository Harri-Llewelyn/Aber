import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/**
 * Gitea's own "Sign out" link, made to mean something.
 *
 * =================================================================================================
 * WHY GITEA'S SIGN-OUT DID NOTHING, AND WHY ROUTING IT TO THE DOOR'S SIGN-OUT WOULD NOT HAVE FIXED IT
 *
 * Under reverse-proxy authentication Gitea's sign-out clears Gitea's own session cookie and
 * redirects to `/` -- where the next request arrives with `X-WEBAUTH-USER` set again by the forge
 * listener, because the DOOR's cookie is untouched, and Gitea signs the person straight back in.
 * Measured: the link is a plain `GET /user/logout` on 1.27.3, and clicking it changes nothing.
 *
 * Sending that path to the listener's `/oauth2/signout` instead clears the door's cookies -- and
 * then `/` starts a fresh login, GoTrue's consent auto-approves because the DASHBOARD session is
 * still alive, and the person is signed back in after a flicker. Also "does nothing", one step
 * further away.
 *
 * THE FORGE HAS NO SESSION OF ITS OWN. Its identity is the dashboard's, so signing out of the forge
 * is signing out of the platform: this ends every GoTrue session the caller holds, then sends the
 * browser through the door's sign-out, which clears the door's cookies and lands on `/`, whose
 * fresh login now meets a dashboard with no session -- the dashboard's login page. That is the
 * mirror of what the dashboard's own sign-out already does to the forge (utils/studioSignOut.js
 * beacons the door), and it is the one outcome that reads as "signed out".
 *
 * =================================================================================================
 * THE TOKEN IS THE LISTENER'S, NOT THE BROWSER'S. The forge listener's jwt_authn verifies the
 * door's cookie and forwards the access token; this route keeps it (the catch-all strips it before
 * Gitea) so the revocation names the right person. A request with no usable token has nothing to
 * revoke and is still sent through the door's sign-out, so the cookies are cleared either way.
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

  // GLOBAL, deliberately: every session this person holds, the dashboard's included. A local
  // sign-out would end the door's session alone, and the dashboard's would sign them back in on
  // the next visit -- the "does nothing" this exists to end.
  const admin = createClient(supabaseUrl, serviceKey);
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
