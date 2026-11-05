/**
 * The MFA switch as the edge functions that change the platform ask it, beside their role check.
 * The same predicate as mfa_satisfied() (migration 0001), which mirror check 59 holds this to: a
 * caller passes while the Settings row is off, when their role is neither Administrator nor
 * Shopfloor_Manager, when their session gave its code (aal2), or when another identity provider
 * signed them in. The policies cannot see these functions' service-role or credential-service
 * writes, so each function asks here first.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** The Settings row, which 0002 declares off. */
export const MFA_SETTING = "security.require_mfa_for_managers";

/** The roles the switch covers. Every other role, and every machine identity, is never asked. */
export const COVERED_ROLES = ["Administrator", "Shopfloor_Manager"];

/** Sign-in methods whose assurance another identity provider gave, as GoTrue names them in `amr`. */
export const FEDERATED_METHODS = ["oauth", "sso/saml"];

/** require_mfa()'s sentence (0001): the dashboard reads it and links Profile › MFA. */
export const MFA_REFUSAL = "MFA is required for this. Add an authenticator on Profile › MFA, then try again.";

/** The code each refusal carries, as require_mfa()'s detail does. */
export const MFA_REFUSAL_CODE = "mfa_required";

/**
 * A token's claims, decoded and not verified: the caller has already had it accepted by GoTrue.
 * Anything unreadable is no claims, which no check below admits.
 */
export function tokenClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1] ?? "";
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : {};
  } catch {
    return {};
  }
}

/** Whether the session itself is enough, whatever the switch says: aal2, or a federated sign-in. */
export function assuranceSuffices(claims: Record<string, unknown>): boolean {
  if (claims.aal === "aal2") return true;
  const amr = Array.isArray(claims.amr) ? claims.amr : [];
  return amr.some((m) => FEDERATED_METHODS.includes((m as { method?: unknown })?.method as string));
}

/** Whether a role is one the switch covers. */
export const isCoveredRole = (role: string | null | undefined): boolean =>
  typeof role === "string" && COVERED_ROLES.includes(role);

/**
 * Whether the switch is on. The row every role may read, so the caller's own client serves a
 * function that holds no service-role key. A failed read throws: the caller answers 503, never an
 * admission.
 */
export async function mfaSwitchOn(
  // deno-lint-ignore no-explicit-any -- callers pass clients created without a schema type
  client: SupabaseClient<any, any, any>,
): Promise<boolean> {
  const { data, error } = await client
    .from("system_settings")
    .select("value")
    .eq("key", MFA_SETTING)
    .maybeSingle();
  if (error) throw new Error(`the MFA setting could not be read: ${error.message}`);
  return (data as { value?: unknown } | null)?.value === true;
}

/** mfa_satisfied(), for a caller whose role is resolved and whose token GoTrue accepted. */
export async function mfaSatisfied(
  // deno-lint-ignore no-explicit-any -- callers pass clients created without a schema type
  client: SupabaseClient<any, any, any>,
  role: string | null,
  claims: Record<string, unknown>,
): Promise<boolean> {
  if (!isCoveredRole(role) || assuranceSuffices(claims)) return true;
  return !(await mfaSwitchOn(client));
}

/** A refusal in the functions' `{ error, details }` shape, with the code the dashboard reads. */
export type MfaAnswer = { status: number; body: { error: string; details: string; code?: string } };

/**
 * What a function answers before it changes anything, or null to go on: 403 with the sentence
 * when the switch does not admit the caller, 503 when it could not be read. `authorization` is the
 * header the caller sent; its token must already have been accepted.
 */
export async function secondFactorRefusal(
  // deno-lint-ignore no-explicit-any -- callers pass clients created without a schema type
  client: SupabaseClient<any, any, any>,
  role: string | null,
  authorization: string,
): Promise<MfaAnswer | null> {
  const claims = tokenClaims(authorization.replace(/^Bearer\s+/i, ""));
  try {
    if (await mfaSatisfied(client, role, claims)) return null;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return { status: 503, body: { error: "Could not check MFA", details: "The MFA setting could not be read. Try again." } };
  }
  return { status: 403, body: { error: "Forbidden: MFA required", details: MFA_REFUSAL, code: MFA_REFUSAL_CODE } };
}
