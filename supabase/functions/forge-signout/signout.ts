import { corsHeaders } from "../_shared/cors.ts";
import { serviceRoleClient } from "../_shared/serviceClient.ts";

/**
 * Gitea's own "Sign out" link, routed here by the forge listener. Under reverse-proxy
 * authentication Gitea's sign-out clears only its own cookie, and the forge has no session of its
 * own. So this ends the one GoTrue session the door's token names (scope local): the door's own,
 * issued to the forge's OAuth client. The person's other browsers and services keep theirs, as
 * after the dashboard's Sign Out.
 *
 * Local is enough because the browser is then sent to the dashboard's `/sign-out`, which signs this
 * browser out of the dashboard and clears the doors' cookies. The door's next login meets nobody
 * signed in, so the person is not signed straight back in. A request with no usable token is sent
 * there too. Without FRONTEND_PUBLIC_URL the browser goes through the door's own sign-out instead.
 */

/** The dashboard's route, appended to its address; and the door's own sign-out, on this host. */
export const DASHBOARD_SIGN_OUT = "/sign-out?from=forge";
export const DOOR_SIGN_OUT = "/oauth2/signout";

/** Where the browser goes next: the dashboard's sign-out, or the door's while no address is set. */
function nextStop(): string {
  const dashboard = (Deno.env.get("FRONTEND_PUBLIC_URL") ?? "").replace(/\/+$/, "");
  if (/^https?:\/\/[^/]/i.test(dashboard)) return `${dashboard}${DASHBOARD_SIGN_OUT}`;
  console.warn(
    "forge-signout: FRONTEND_PUBLIC_URL is unset or not an http(s) address; sending the browser through " +
      "the door's sign-out, where a dashboard still signed in here signs the person straight back in",
  );
  return DOOR_SIGN_OUT;
}

function onward(): Response {
  return new Response(null, {
    status: 302,
    headers: { ...corsHeaders, Location: nextStop(), "Cache-Control": "no-store" },
  });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    console.warn("forge-signout: no bearer token to end; sending the browser on to sign out");
    return onward();
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const token = authHeader.slice("Bearer ".length);

  // Local: the session this token names, and no other.
  const admin = serviceRoleClient(supabaseUrl, serviceKey);
  const { error } = await admin.auth.admin.signOut(token, "local");
  if (error) {
    // Already ended is the ordinary failure here, and not a reason to stop the browser signing out.
    console.warn(`forge-signout: could not end the door's session (${error.message}); sending the browser on anyway`);
  } else {
    console.log("forge-signout: ended the door's session");
  }
  return onward();
}
