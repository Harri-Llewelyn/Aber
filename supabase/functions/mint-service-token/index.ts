/**
 * Mint a long-lived JWT for a service principal, and reveal it once.
 *
 * =================================================================================================
 * WHY THIS IS A FUNCTION AND NOT AN RPC, WHICH IS THE WHOLE DESIGN
 *
 * The revocable-tokens roadmap item -- since shipped, so named rather than numbered -- sketched
 * this as a SECURITY DEFINER RPC signing with pgjwt, on the reasoning that it needs "no new
 * dependency and no secret leaving the database". pgjwt IS installed. The premise under it is
 * false: SUPABASE_JWT_SECRET is not in that database and never has been.
 *
 * Putting it there would work, and it is the one thing that must not happen. That key signs
 * ANYTHING -- including a `service_role` token, which is accepted by storage, realtime, the edge
 * runtime and Studio, and which 0074 CANNOT revoke because `auth_pre_request()` is a PostgREST
 * hook and those four consult no denylist. Storing it in the database converts every path to SQL
 * execution into a path to an unrevocable god credential.
 *
 * The edge runtime already holds JWT_SECRET and already holds it for signing. So the key stays
 * exactly where it is and the mint comes to it -- which is also the shape this repository uses for
 * every other "issue a secret" act: `enroll-gateway` and `gateway-credential` both mint, record
 * before returning, and reveal once.
 *
 * =================================================================================================
 * TWO CHECKS, AND THE SECOND ONE IS NOT REDUNDANT
 *
 * This function verifies the caller's session and resolves their role before it signs anything.
 * `record_service_token_issued()` (0075) then re-checks the actor against `user_roles` itself.
 *
 * THAT DUPLICATION IS DELIBERATE and mirrors what `approve-quarantine` does, for the reason its
 * caller states: authorisation must not rest solely on a check made inside the component that also
 * holds the signing key. If this worker were ever reached without its own check running -- a
 * refactor, a router change, a mistake -- the database still refuses to record an attributed mint
 * for somebody who is not an Administrator, and an unrecorded mint is not returned at all.
 *
 * =================================================================================================
 * THE ROW IS WRITTEN BEFORE THE SECRET IS RETURNED, AND THE ORDER IS THE POINT
 *
 * `mint-mcp-token.mjs` records the same way and says why: the reverse order costs an unrevocable
 * credential in the wild with no record of it, which is the worst outcome available. Here it is
 * sharper than it was there, because the record is now what makes revocation POSSIBLE --
 * `revoke_service_token()` refuses a jti with no TOKEN_MINTED row. A token returned without its
 * row would be one nobody could ever withdraw.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { create, getNumericDate } from "https://deno.land/x/djwt@v2.9.1/mod.ts";
import { resolveUserRole } from "../_shared/roles.ts";
import { corsHeaders } from "../_shared/cors.ts";
// IMPORTED FROM ANOTHER FUNCTION'S DIRECTORY, WHICH LOOKS WRONG AND IS THE RIGHT CHOICE HERE.
//
// This validator exists in exactly two places -- the frontend and that file -- and CI asserts the
// two regexes are byte-identical by grepping those two paths by name. A third copy here would be
// outside that check: it could drift silently, and a UUID validator that disagrees with the one
// beside it is how a value gets rejected at one door and accepted at another.
//
// `_shared` would be the tidier home and moving it there is deliberately NOT done as part of this
// change -- it would mean editing the CI step's hardcoded path in the same commit that adds a
// signing endpoint, and those two things should not ride together. Cross-directory imports work
// (see _shared/roles.ts, which measured it on v1.74.2).
import { isUuid } from "../approve-quarantine/isUuid.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";

// ADMINISTRATOR ALONE. Minting is an access-control act, and gating it here adds a sixth
// Administrator-only decision in the direction the database already goes -- it did not wait on the
// role split, which has shipped anyway (0069, 0070).
const ALLOWED_ROLES = ["Administrator"];

// Mirrors public.service_token_max_days(). THE DATABASE IS STILL THE AUTHORITY: this is a fast
// refusal so an over-long request never reaches the signing step, and 0075 refuses it again. If
// the two ever disagree the database wins and this returns its message.
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

    // ------------------------------------------------------------------------------------------
    // What was asked for
    // ------------------------------------------------------------------------------------------
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
    // SHAPE ONLY. Whether this id is a principal AT ALL, and whether it is a service principal
    // rather than a person's account, is decided by record_service_token_issued() -- which reads
    // auth.users and refuses an account that can sign in. That check must not be duplicated here:
    // this worker holds the signing key and should make as few policy decisions as possible.
    if (!isUuid(principalId)) {
      return badRequest("principal_id must be a UUID");
    }

    // DEFAULTED RATHER THAN REQUIRED, and bounded at both ends. A zero or negative TTL would sign
    // a token already expired; the database refuses that too, but refusing it here keeps the
    // failure a 400 about the request rather than a 500 carrying a Postgres message.
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

    // ------------------------------------------------------------------------------------------
    // Sign
    // ------------------------------------------------------------------------------------------
    // THE CLAIM SET IS mint-mcp-token.mjs's, EXACTLY. Two mints of the same identity must be
    // indistinguishable to everything downstream -- PostgREST resolves `sub` and `role`, and 0074's
    // hook reads `jti`. A shape that differed by one claim would produce tokens that behave
    // differently depending on which door issued them.
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

    // ------------------------------------------------------------------------------------------
    // Record BEFORE returning, and refuse to return if that fails
    // ------------------------------------------------------------------------------------------
    // AS THE CALLER, not as service_role. This function holds no service-role key -- see the entry
    // in main/index.ts -- and does not need one: `record_service_token_issued()` is SECURITY
    // DEFINER and does its own checking, so the write does not require a wider identity than the
    // person who asked for it.
    //
    // `p_actor_id` is the actual authorisation carrier here. 0075 re-checks it against user_roles,
    // so a caller who somehow reached this far without being an Administrator gets no row -- and
    // therefore no token.
    const { data: auditId, error: recordError } = await supabaseUser.rpc(
      "record_service_token_issued",
      {
        p_principal_id: principalId,
        p_jti: jti,
        p_expires_at: expiresAt.toISOString(),
        // EMPTY, DELIBERATELY. The two host scripts fill `os_user` and `host` because there is a
        // shell to name. There is no such thing behind a browser, and inventing one would put an
        // unverifiable claim in an audit row beside a verified `changed_by`.
        p_context: {},
        p_actor_id: user.id,
      },
    );

    if (recordError) {
      // THE TOKEN IS DISCARDED HERE, and this is the branch that matters most in the whole file.
      // It has been signed and is cryptographically valid -- but nothing has recorded it, so
      // nobody could ever revoke it: revoke_service_token() refuses a jti with no TOKEN_MINTED
      // row. Returning it would create precisely the credential this item exists to prevent.
      console.error(`mint-service-token: refusing to return an unrecorded token: ${recordError.message}`);
      return jsonResponse({
        error: "The token could not be recorded, so it has not been issued.",
        details: recordError.message,
      }, 400);
    }

    // ------------------------------------------------------------------------------------------
    // Reveal once
    // ------------------------------------------------------------------------------------------
    // NO Cache-Control HEADER IS ENOUGH ON ITS OWN. This is returned exactly once because nothing
    // stores it: the signature is reproducible only from JWT_SECRET, and no row anywhere holds the
    // token. The page says so, and this comment is here so a later change that "helpfully" caches
    // the response has to argue with it first.
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

serve(handler);
