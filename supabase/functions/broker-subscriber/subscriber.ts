/**
 * Create or delete a read-only broker account, for a consumer outside Aber, from Access Control ›
 * Broker accounts. The account holds the broker's `subscriber` role and nothing else: it reads
 * `spBv1.0/#` and the Unified Namespace and publishes nothing. Its purpose lives in the plugin's
 * own textname and textdescription; no table records the account.
 *
 *   { action: "create", name, description } asks the credential service's POST /subscribers,
 *     which generates the username and the password. The password is returned here once; nothing
 *     stores or logs it.
 *   { action: "delete", username } asks POST /subscriber-deletions. A username outside the
 *     subscriber scheme is refused here, and again there.
 *
 * Administrator only, checked from the caller's session before the credential service is asked
 * anything, and again by the SECURITY DEFINER function that writes each act's Audit Trail row
 * (0218) as the caller. No service-role key: the credential service's bearer token is the one
 * authority this holds, as broker-inventory holds it.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";
import { serverError } from "../_shared/failure.ts";
import { resolveUserRole } from "../_shared/roles.ts";

/** "sub" and 21 lowercase hex characters, as scripts/lib/mosquitto-credentials.mjs spells it. */
export const SUBSCRIBER_USERNAME = /^sub[0-9a-f]{21}$/;

/** What an account is for: each required, trimmed, on one line, at most this many characters. */
export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;

// deno-lint-ignore no-control-regex -- refusing control characters is the point
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

const FN = "broker-subscriber";

// deno-lint-ignore no-explicit-any -- clients created without a schema type
type Client = SupabaseClient<any, any, any>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    // no-store: a response can carry a password.
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** The sentence a refused name or description answers with, or null when it is usable. */
export function purposeProblem(field: "name" | "description", value: unknown): string | null {
  const max = field === "name" ? NAME_MAX : DESCRIPTION_MAX;
  const text = typeof value === "string" ? value.trim() : "";
  const length = [...text].length;
  if (length === 0) return `The account needs a ${field}: say what it is for.`;
  if (length > max || CONTROL_CHARACTER.test(text)) {
    return `The ${field} must be 1-${max} characters on one line.`;
  }
  return null;
}

/** One call to the credential service: its status and body, or null when it could not be reached. */
async function credentialService(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const url = (Deno.env.get("MQTT_CREDENTIAL_SERVICE_URL") ?? "").replace(/\/+$/, "");
  try {
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("MQTT_CREDENTIAL_SERVICE_TOKEN") ?? ""}`,
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    if (!response.ok) console.error(`${FN}: credential service answered ${response.status}: ${text.slice(0, 300)}`);
    return { status: response.status, body: parsed };
  } catch (err) {
    console.error(`${FN}: credential service unreachable: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function create(body: Record<string, unknown>, caller: Client): Promise<Response> {
  for (const field of ["name", "description"] as const) {
    const problem = purposeProblem(field, body[field]);
    if (problem) return json(400, { error: "The account was not created", details: problem });
  }

  // The name and description alone: the service generates the username and password, and the role
  // is not the caller's to choose.
  const answer = await credentialService("/subscribers", {
    name: String(body.name).trim(),
    description: String(body.description).trim(),
  });
  const made = answer?.body as { username?: string; password?: string; name?: string; description?: string } | undefined;
  if (!answer || answer.status !== 200 || !made?.password || !SUBSCRIBER_USERNAME.test(made.username ?? "")) {
    return json(503, {
      error: "The account was not created",
      details: "The broker credential service could not create it. Nothing was changed; retry.",
    });
  }

  // Written only now that the account exists. A failure does not withhold the password: the broker
  // stores only its hash, so withholding it would strand an account nobody can use.
  const { error: auditError } = await caller.rpc("record_broker_account_created", {
    p_username: made.username,
    p_name: made.name,
    p_description: made.description,
  });
  if (auditError) console.error(`${FN}: audit row not written for ${made.username}: ${auditError.message}`);

  return json(200, {
    mqtt_username: made.username,
    password: made.password,
    name: made.name,
    description: made.description,
    role: "subscriber",
    audit_recorded: !auditError,
  });
}

async function remove(body: Record<string, unknown>, caller: Client): Promise<Response> {
  const username = typeof body.username === "string" ? body.username : "";
  if (!SUBSCRIBER_USERNAME.test(username)) {
    return json(400, {
      error: "The account was not deleted",
      details: "Only a read-only account (\"sub\" and 21 lowercase hex characters) is deleted here: never a " +
        "gateway, one of Aber's own accounts or an account made by hand.",
    });
  }

  const answer = await credentialService("/subscriber-deletions", { username });
  const result = answer?.body as { existed?: boolean; name?: string | null; description?: string | null } | undefined;
  if (!answer || answer.status !== 200) {
    return json(503, {
      error: "The account was not deleted",
      details: "The broker credential service could not delete it. Retry.",
    });
  }
  if (result?.existed !== true) {
    return json(404, { error: "The account was not deleted", details: "The broker holds no account by that name." });
  }

  const { error: auditError } = await caller.rpc("record_broker_account_deleted", {
    p_username: username,
    p_name: result.name ?? null,
    p_description: result.description ?? null,
  });
  if (auditError) console.error(`${FN}: audit row not written for ${username}: ${auditError.message}`);

  return json(200, { mqtt_username: username, deleted: true, audit_recorded: !auditError });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed", details: "Use POST." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const missing = [
    !supabaseUrl && "SUPABASE_URL",
    !gatewayKey() && "SUPABASE_PUBLISHABLE_KEY",
    !Deno.env.get("MQTT_CREDENTIAL_SERVICE_URL") && "MQTT_CREDENTIAL_SERVICE_URL",
    !Deno.env.get("MQTT_CREDENTIAL_SERVICE_TOKEN") && "MQTT_CREDENTIAL_SERVICE_TOKEN",
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(`${FN}: missing ${missing.join(", ")}`);
    return json(500, {
      error: "Read-only broker accounts are not configured",
      details: `The server is missing: ${missing.join(", ")}.`,
    });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json(401, { error: "Unauthorized", details: "A signed-in session is required." });
  }

  try {
    // The caller's own token, so the role lookup and the audit functions run as them.
    const caller = createClient(supabaseUrl, gatewayKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await caller.auth.getUser(authHeader.slice("Bearer ".length));
    if (userError || !user) {
      return json(401, { error: "Invalid user token", details: userError?.message });
    }

    // Before the credential service is asked anything, so a refused caller changes nothing.
    if (await resolveUserRole(caller, user.id) !== "Administrator") {
      return json(403, {
        error: "Forbidden: Insufficient privileges",
        details: "Only an Administrator may create or delete a read-only broker account.",
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Malformed request", details: "Expected a JSON body." });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json(400, { error: "Malformed request", details: "Expected a JSON object." });
    }

    switch (body.action) {
      case "create":
        return await create(body, caller);
      case "delete":
        return await remove(body, caller);
      default:
        return json(400, { error: "Malformed request", details: "`action` must be create or delete." });
    }
  } catch (err) {
    return serverError(req, FN, err);
  }
}
