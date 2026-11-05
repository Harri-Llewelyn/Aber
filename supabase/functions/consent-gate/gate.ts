/**
 * Whether a person may approve an app's sign-in now: the gateway listener's `ext_authz` step on
 * GoTrue's consent endpoints (`/auth/v1/oauth/authorizations/`, supabase/envoy.yaml). Both of the
 * consent page's calls pass here with the person's dashboard session: the GET that reads the
 * request, in which GoTrue approves an app already allowed, and the POST that approves it. Every
 * token an app then holds was won through one of them.
 *
 * Read live on every call, as the switch can change between two: the person's role (user_roles),
 * `aal` and `amr` from the bearer, the switch, and the authorization's app. Admits an uncovered
 * role, a session that gave its code or another identity provider signed in, a switch that is off,
 * and Grafana's sign-in, which the switch does not cover. Refuses the rest with 403 and GoTrue's
 * error shape, whose `msg` the consent page shows. A failure to read anything is a 503, which the
 * listener refuses too (failure_mode_allow: false).
 */

import { createClient, isAuthRetryableFetchError } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";
import { lookUpUserRole } from "../_shared/roles.ts";
import {
  assuranceSuffices,
  isCoveredRole,
  MFA_REFUSAL,
  MFA_REFUSAL_CODE,
  mfaSwitchOn,
  tokenClaims,
} from "../_shared/secondFactor.ts";
import { serviceRoleClient } from "../_shared/serviceClient.ts";

const FN = "consent-gate";

/** Grafana's client (0002, stack_app_ids()): its sign-in passes at aal1. Mirror check 59. */
export const GRAFANA_CLIENT_ID = "c0ffee00-0000-4000-8000-000000000001";

/** The authorization id in the path the listener forwards: the segment after `authorizations/`. */
export function authorizationIdOf(pathname: string): string | null {
  const m = pathname.match(/\/oauth\/authorizations\/([^/]+)/);
  return m ? m[1] : null;
}

export type Decision = { admit: boolean; reason: string };

/** The decision once its facts are known; `switchOn` and `clientId` are asked only when needed. */
export async function decide(facts: {
  role: string | null;
  claims: Record<string, unknown>;
  switchOn: () => Promise<boolean>;
  clientId: () => Promise<string | null>;
}): Promise<Decision> {
  if (!isCoveredRole(facts.role)) return { admit: true, reason: `role ${facts.role ?? "none"} is not covered` };
  if (assuranceSuffices(facts.claims)) return { admit: true, reason: "the session gave its code" };
  if (!(await facts.switchOn())) return { admit: true, reason: "MFA is not required" };
  if ((await facts.clientId()) === GRAFANA_CLIENT_ID) return { admit: true, reason: "Grafana is not covered" };
  return { admit: false, reason: "MFA is required" };
}

/** GoTrue's error shape (`code`, `error_code`, `msg`), which the consent page reads. */
function goTrueError(status: number, errorCode: string, msg: string): Response {
  return new Response(JSON.stringify({ code: status, error_code: errorCode, msg }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function unavailable(what: string, err: unknown): Response {
  console.error(JSON.stringify({ level: "error", function: FN, context: what, message: err instanceof Error ? err.message : String(err) }));
  return goTrueError(503, "consent_check_unavailable", "The sign-in could not be checked. Try again in a moment.");
}

export async function handler(req: Request): Promise<Response> {
  const authorization = req.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token || token === authorization) {
    return goTrueError(401, "no_authorization", "Sign in to the dashboard first, then start the app's sign-in again.");
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";

  // Verified by GoTrue, which also knows whether the session still exists. Only then are its
  // claims read.
  const asCaller = createClient(supabaseUrl, gatewayKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: { user }, error: userError } = await asCaller.auth.getUser(token);
  if (userError && (isAuthRetryableFetchError(userError) || (userError.status ?? 0) >= 500)) {
    return unavailable("GoTrue did not answer the session check", userError);
  }
  if (userError || !user) {
    return goTrueError(401, "bad_jwt", "Your session has ended. Sign in to the dashboard again.");
  }

  const asService = serviceRoleClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
  let role: string | null;
  try {
    role = await lookUpUserRole(asService, user.id);
  } catch (err) {
    return unavailable(`role lookup for ${user.id}`, err);
  }

  const authorizationId = authorizationIdOf(new URL(req.url).pathname);
  let decision: Decision;
  try {
    decision = await decide({
      role,
      claims: tokenClaims(token),
      switchOn: () => mfaSwitchOn(asService),
      clientId: async () => {
        if (!authorizationId) return null;
        const { data, error } = await asService.rpc("oauth_authorization_client", { p_authorization_id: authorizationId });
        if (error) throw new Error(`the authorization's app could not be read: ${error.message}`);
        return typeof data === "string" ? data : null;
      },
    });
  } catch (err) {
    return unavailable("the switch or the authorization's app", err);
  }

  if (!decision.admit) {
    console.warn(`${FN}: ${user.id} (${role}) refused at the consent step: ${decision.reason}`);
    return goTrueError(403, MFA_REFUSAL_CODE, MFA_REFUSAL);
  }
  return new Response(JSON.stringify({ sub: user.id, reason: decision.reason }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
