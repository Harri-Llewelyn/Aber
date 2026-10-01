/**
 * Mint a long-lived JWT for a service principal, and reveal it once. A function and not an RPC,
 * because JWT_SECRET is not in the database and must not be: it signs anything, including a
 * `service_role` token that storage, realtime, the edge runtime and Studio accept without
 * consulting the denylist, so storing it in SQL would turn every path to SQL execution into a path
 * to an unrevocable credential. The edge runtime already holds the key, so the mint comes to it.
 *
 * Two checks: this function verifies the caller's session and role, and
 * `record_service_token_issued()` re-checks the actor against `user_roles` itself, so authorisation
 * does not rest solely on the component that holds the signing key. The row is written before the
 * secret is returned: `revoke_service_token()` refuses a jti with no TOKEN_MINTED row, so a token
 * returned without its row could never be withdrawn.
 */

import { createClient } from "@supabase/supabase-js";
import { create, getNumericDate } from "djwt";
import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";
// Imported from another function's directory: this validator exists in exactly two places, the
// frontend and that file, and CI asserts the two regexes are byte-identical by path. A third copy
// here would be outside that check. Cross-directory imports work (see _shared/roles.ts).
import { isUuid } from "../approve-quarantine/isUuid.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";

// Administrator alone: minting is an access-control act.
const ALLOWED_ROLES = ["Administrator"];

// Mirrors public.service_token_max_days(). The database is still the authority; this is a fast
// refusal so an over-long request never reaches the signing step.
const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function badRequest(message: string): Response {
  return jsonResponse({ error: message }, 400);
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing Authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = gatewayKey();
    const jwtSecret = Deno.env.get("JWT_SECRET");

    // 500 WITH NOTHING SPECIFIC, matching every other function here. A response naming the missing
    // variable would tell an unauthenticated caller how this endpoint is wired.
    if (!jwtSecret) {
      console.error("mint-service-token: JWT_SECRET is not set; this worker cannot sign.");
      return jsonResponse({ error: "Server misconfiguration" }, 500);
    }

    // THE CALLER'S OWN TOKEN, so the role lookup runs under their RLS and cannot see more than
    // they could. `_shared/roles.ts` explains why the client is passed in rather than built there.
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const callerToken = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser(callerToken);
    if (userError || !user) {
      return jsonResponse({ error: "Invalid user token", details: userError?.message }, 401);
    }

    const userRole = await resolveUserRole(supabaseUser, user.id);
    if (!userRole || !ALLOWED_ROLES.includes(userRole)) {
      return jsonResponse({ error: "Forbidden: Insufficient privileges" }, 403);
    }

    // What was asked for
    let body: { principal_id?: unknown; days?: unknown };
    try {
      body = await req.json();
    } catch {
      return badRequest("Body must be JSON");
    }

    const principalId = typeof body.principal_id === "string" ? body.principal_id.trim() : "";
    if (!principalId) {
      return badRequest("Missing required parameter: principal_id");
    }
    // Shape only. Whether this id is a service principal rather than a person's account is decided
    // by record_service_token_issued(), which reads auth.users; this worker holds the signing key
    // and should make as few policy decisions as possible.
    if (!isUuid(principalId)) {
      return badRequest("principal_id must be a UUID");
    }

    // Defaulted rather than required, and bounded at both ends, so a bad TTL is a 400 about the
    // request rather than a 500 carrying a Postgres message.
    let days = DEFAULT_DAYS;
    if (body.days !== undefined && body.days !== null) {
      const asNumber = Number(body.days);
      if (!Number.isFinite(asNumber) || !Number.isInteger(asNumber)) {
        return badRequest("days must be a whole number");
      }
      if (asNumber < 1 || asNumber > MAX_DAYS) {
        return badRequest(`days must be between 1 and ${MAX_DAYS}`);
      }
      days = asNumber;
    }

    // Sign. The claim set is mint-mcp-token.mjs's exactly: PostgREST resolves `sub` and `role`, and
    // the denylist hook reads `jti`, so two mints of one identity must be indistinguishable
    // downstream.
    const jti = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + days * 86400_000);

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(jwtSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );

    const token = await create(
      { alg: "HS256", typ: "JWT" },
      {
        sub: principalId,
        role: "authenticated",
        iat: getNumericDate(0),
        exp: getNumericDate(expiresAt),
        jti,
      },
      key,
    );

    // Record before returning, and refuse to return if that fails. As the caller, not as
    // service_role: `record_service_token_issued()` is SECURITY DEFINER and re-checks `p_actor_id`
    // against user_roles, so a caller who is not an Administrator gets no row and therefore no
    // token.
    const { data: auditId, error: recordError } = await supabaseUser.rpc(
      "record_service_token_issued",
      {
        p_principal_id: principalId,
        p_jti: jti,
        p_expires_at: expiresAt.toISOString(),
        // Empty, deliberately: the host scripts fill `os_user` and `host` because there is a shell
        // to name, and there is no such thing behind a browser.
        p_context: {},
        p_actor_id: user.id,
      },
    );

    if (recordError) {
      // The token is discarded here. It is signed and valid, but nothing has recorded it, so nobody
      // could ever revoke it; returning it would create precisely the credential this exists to
      // prevent.
      console.error(`mint-service-token: refusing to return an unrecorded token: ${recordError.message}`);
      return jsonResponse({
        error: "The token could not be recorded, so it has not been issued.",
        details: recordError.message,
      }, 400);
    }

    // Reveal once. Nothing stores it: the signature is reproducible only from JWT_SECRET, and no
    // row holds the token. A later change that caches this response has to argue with this comment
    // first.
    return jsonResponse({
      token,
      jti,
      principal_id: principalId,
      expires_at: expiresAt.toISOString(),
      audit_row_id: auditId,
      // WHAT IT IS AND IS NOT REVOCABLE AGAINST, carried in the response so the page does not have
      // to hardcode a claim about coverage that could drift from 0074.
      revocation_scope: "postgrest",
    }, 200);
  } catch (err) {
    console.error(`mint-service-token: ${err instanceof Error ? err.message : String(err)}`);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
}

Deno.serve(handler);
