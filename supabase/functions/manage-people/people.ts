/**
 * Add a person, remove their access, restore it, or set them a new password: the GoTrue half of the
 * People tab. A function and not an RPC because GoTrue's admin API needs the secret key, which is
 * not in the database.
 *
 * Administrator only, checked twice: here, from the caller's session, before any admin call; and by
 * the SECURITY DEFINER function each act calls in the caller's session, which also writes its audit
 * row. Removing, restoring and setting a password call the database FIRST, so its rules (not your
 * own account, not the last Administrator who can sign in) are decided before GoTrue changes
 * anything. Removing bans the account and never deletes it: the Audit Trail names the person
 * through it.
 *
 * A new account without a mail relay, and every new password, is minted here and returned once.
 * Nothing stores or logs it; GoTrue keeps only its hash.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";
import { serverError } from "../_shared/failure.ts";
import { resolveUserRole } from "../_shared/roles.ts";
import { serviceRoleClient } from "../_shared/serviceClient.ts";
// The validator CI keeps byte-identical with the frontend's; see mint-service-token.
import { isUuid } from "../approve-quarantine/isUuid.ts";

/** The four roles a person may hold; set_person_role() refuses anything else as well. */
export const ROLES = ["Administrator", "Shopfloor_Manager", "Operator", "Auditor"];

/** About a hundred years. GoTrue has no permanent ban; `none` lifts one. */
export const BAN_DURATION = "876000h";

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/** The shape `npm run setup` gives the first administrator's password: 24 characters with no
 *  look-alikes, about 119 bits, in groups of six. */
export function initialPassword(): string {
  // Rejection sampling: a byte at or above the largest multiple of 31 is dropped, so every
  // character is equally likely.
  const limit = 256 - (256 % ALPHABET.length);
  const chars: string[] = [];
  while (chars.length < 24) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < limit && chars.length < 24) chars.push(ALPHABET[byte % ALPHABET.length]);
    }
  }
  return [0, 6, 12, 18].map((i) => chars.slice(i, i + 6).join("")).join("-");
}

/** ensure_first_administrator()'s test of an address, so both paths accept the same ones. */
const EMAIL = /^[^@\s]+@[^@\s]+$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    // no-store: a response can carry a password.
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

type DbError = { code?: string; message?: string };
type AuthError = { status?: number; code?: string; message?: string };
// deno-lint-ignore no-explicit-any -- clients created without a schema type
type Client = SupabaseClient<any, any, any>;

/** A database refusal as an HTTP status, carrying the database's own sentence. */
function dbRefusal(error: DbError, what: string): Response {
  const status = error.code === "42501" ? 403
    : error.code === "P0002" ? 404
    : error.code === "P0001" ? 409
    : error.code === "22023" ? 400
    : 500;
  if (status === 500) console.error(`manage-people: ${what}: ${error.message}`);
  return json(status, { error: what, details: error.message });
}

/** A GoTrue refusal: an address already in use is the caller's to fix, an outage is not. */
function authRefusal(error: AuthError, what: string): Response {
  if (error.code === "email_exists" || error.code === "user_already_exists" ||
    /already (been )?registered|already exists/i.test(error.message ?? "")) {
    return json(409, { error: what, details: "An account with this email address already exists." });
  }
  if (error.status === 404) {
    return json(404, { error: what, details: "The sign-in service has no such account." });
  }
  if (error.status && error.status >= 400 && error.status < 500) {
    return json(400, { error: what, details: error.message });
  }
  console.error(`manage-people: GoTrue answered ${error.status ?? "without a status"}: ${error.message}`);
  return json(502, {
    error: what,
    details: error.status
      ? `The sign-in service refused: ${error.message}. Nothing was changed.`
      : "The sign-in service did not answer. Nothing was changed; retry.",
  });
}

function targetOf(
  body: Record<string, unknown>,
  callerId: string,
  ownRefusal = "You cannot change your own access. Ask another Administrator.",
): string | Response {
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  if (!isUuid(userId)) {
    return json(400, { error: "Malformed request", details: "`user_id` must be the person's UUID." });
  }
  if (userId === callerId) {
    return json(403, { error: "Forbidden", details: ownRefusal });
  }
  return userId;
}

async function addPerson(body: Record<string, unknown>, caller: Client, admin: Client): Promise<Response> {
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) {
    return json(400, { error: "Malformed request", details: "`email` must be an email address." });
  }
  const role = typeof body.role === "string" ? body.role : "";
  if (!ROLES.includes(role)) {
    return json(400, { error: "Malformed request", details: `\`role\` must be one of ${ROLES.join(", ")}.` });
  }

  // Asked first, because GoTrue's invitation to an address it already holds, unconfirmed, re-sends
  // to that account instead of refusing, and that account is not this request's to record or undo.
  const { data: people, error: listError } = await caller.rpc("list_people");
  if (listError) return dbRefusal(listError, "The person was not added");
  if (((people ?? []) as { email?: string | null }[]).some((p) => p.email?.toLowerCase() === email)) {
    return json(409, { error: "The person was not added", details: "An account with this email address already exists." });
  }

  // An invitation when GoTrue can send mail: the person chooses their own password from the link.
  const invited = Deno.env.get("AUTH_SMTP_CONFIGURED") === "true";
  let password: string | null = null;
  let created: { id?: string; created_at?: string; last_sign_in_at?: string | null } | null = null;
  if (invited) {
    const redirectTo = Deno.env.get("AUTH_INVITE_REDIRECT_URL") || undefined;
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, redirectTo ? { redirectTo } : {});
    if (error) return authRefusal(error, "The invitation was not sent");
    created = data.user;
  } else {
    password = initialPassword();
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return authRefusal(error, "The account was not created");
    created = data.user;
  }
  const userId = created?.id;
  if (!userId) {
    console.error("manage-people: GoTrue answered without the new account's id");
    return json(502, { error: "The person was not added", details: "The sign-in service returned no account." });
  }

  // The role and the audit row, as the caller. If they fail, an account this request created is
  // deleted again rather than left with no role and no record; it has never been used.
  const { error: recordError } = await caller.rpc("record_person_added", {
    p_user_id: userId,
    p_role: role,
    p_invited: invited,
  });
  if (recordError) {
    const fresh = !created?.last_sign_in_at &&
      Date.now() - Date.parse(created?.created_at ?? "") < 10 * 60_000;
    const { error: undoError } = fresh ? await admin.auth.admin.deleteUser(userId) : { error: { message: "not new" } };
    if (undoError) {
      console.error(`manage-people: unrecorded account ${userId} was not deleted: ${undoError.message}`);
      return json(500, {
        error: "The person was not added",
        details: `${recordError.message}. The account the sign-in service holds for this address was ` +
          "not deleted; check its role and access on the People tab.",
      });
    }
    return dbRefusal(recordError, "The person was not added");
  }

  return json(200, { user_id: userId, email, role, invited, ...(password ? { password } : {}) });
}

async function removeAccess(body: Record<string, unknown>, callerId: string, caller: Client, admin: Client) {
  const userId = targetOf(body, callerId);
  if (userId instanceof Response) return userId;

  const { error } = await caller.rpc("remove_person_access", { p_user_id: userId });
  if (error) return dbRefusal(error, "Access was not removed");

  const { error: banError } = await admin.auth.admin.updateUserById(userId, { ban_duration: BAN_DURATION });
  if (banError) {
    console.error(`manage-people: role removed but ${userId} not banned: ${banError.message}`);
    return json(502, {
      error: "Sign-in is not blocked yet",
      details: "Their role is removed, so they can do nothing that needs one, but the sign-in " +
        "service did not block the account. Select Remove access again.",
    });
  }
  return json(200, { user_id: userId, access: "removed" });
}

async function restoreAccess(body: Record<string, unknown>, callerId: string, caller: Client, admin: Client) {
  const userId = targetOf(body, callerId);
  if (userId instanceof Response) return userId;

  const { data: role, error } = await caller.rpc("restore_person_access", { p_user_id: userId });
  if (error) return dbRefusal(error, "Access was not restored");

  const { error: unbanError } = await admin.auth.admin.updateUserById(userId, { ban_duration: "none" });
  if (unbanError) {
    console.error(`manage-people: role restored but ${userId} still banned: ${unbanError.message}`);
    return json(502, {
      error: "Sign-in is still blocked",
      details: "Their role is back, but the sign-in service did not lift the block. Select Restore " +
        "access again.",
    });
  }
  return json(200, { user_id: userId, access: "active", role: typeof role === "string" ? role : null });
}

/**
 * A new password for someone else, minted as `add` mints one, with or without a mail relay. One
 * function decides and records: called with p_check_only before GoTrue, so a refusal changes
 * nothing, and again after it to write PASSWORD_SET. If that record fails, the password WAS changed
 * and nobody has seen it, so the answer withholds it and says to set it again.
 */
async function setPassword(body: Record<string, unknown>, callerId: string, caller: Client, admin: Client) {
  const userId = targetOf(body, callerId,
    "You cannot set your own password here. Use Change Password in your account menu.");
  if (userId instanceof Response) return userId;

  const { error } = await caller.rpc("record_person_password_set", { p_user_id: userId, p_check_only: true });
  if (error) return dbRefusal(error, "The password was not set");

  const password = initialPassword();
  const { error: authError } = await admin.auth.admin.updateUserById(userId, { password });
  if (authError) return authRefusal(authError, "The password was not set");

  const { error: recordError } = await caller.rpc("record_person_password_set", {
    p_user_id: userId,
    p_check_only: false,
  });
  if (recordError) {
    console.error(`manage-people: password set for ${userId} but not recorded: ${recordError.message}`);
    return json(500, {
      error: "The password was changed but not recorded",
      details: `The sign-in service now holds a new password for this person, which nobody has seen, ` +
        `but the Audit Trail did not record it: ${recordError.message}. Select Set New Password again.`,
    });
  }
  return json(200, { user_id: userId, password });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed", details: "Use POST." });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json(401, { error: "Unauthorized", details: "A signed-in session is required." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  // Nothing specific in the answer, as mint-service-token: the caller is not yet known.
  if (!supabaseUrl || !gatewayKey() || !serviceKey) {
    console.error("manage-people: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY or SUPABASE_SERVICE_ROLE_KEY is not set");
    return json(500, { error: "Server misconfiguration" });
  }

  try {
    // The caller's own token, so the role lookup and every RPC run as them.
    const caller = createClient(supabaseUrl, gatewayKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await caller.auth.getUser(authHeader.slice("Bearer ".length));
    if (userError || !user) {
      return json(401, { error: "Invalid user token", details: userError?.message });
    }

    // Before any admin call, so a refused caller cannot make GoTrue do anything.
    if (await resolveUserRole(caller, user.id) !== "Administrator") {
      return json(403, {
        error: "Forbidden: Insufficient privileges",
        details: "Only an Administrator may add people, or change their access or password.",
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Malformed request", details: "Expected a JSON body." });
    }
    if (!body || typeof body !== "object") {
      return json(400, { error: "Malformed request", details: "Expected a JSON object." });
    }

    const admin = serviceRoleClient(supabaseUrl, serviceKey);
    switch (body.action) {
      case "add":
        return await addPerson(body, caller, admin);
      case "remove":
        return await removeAccess(body, user.id, caller, admin);
      case "restore":
        return await restoreAccess(body, user.id, caller, admin);
      case "set-password":
        return await setPassword(body, user.id, caller, admin);
      default:
        return json(400, {
          error: "Malformed request",
          details: "`action` must be add, remove, restore or set-password.",
        });
    }
  } catch (err) {
    return serverError(req, "manage-people", err);
  }
}
