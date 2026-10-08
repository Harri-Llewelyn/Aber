/**
 * The RBAC role lookup, shared by every edge function that makes an authorisation decision. A
 * sibling import is fine on supabase/edge-runtime: `servicePath` decides which directory is booted,
 * not what the module graph may import, and both delivery paths ship the whole tree. Reading files
 * at runtime is a different mechanism and is still confined to the service path. `_shared` is not
 * reachable as a function: `main/index.ts` answers 404 for any name not in FUNCTION_REGISTRY.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Resolve a user's role name from `public.user_roles`, or null. The client is the caller's
 * decision: a caller-bound client applies RLS (`approve-quarantine`, `aas-export`); a service-role
 * client is a lookup after the user id was authenticated some other way (`grafana-userinfo`,
 * `nodered-userinfo`). A failed lookup returns null, and every caller treats null as no role and
 * fails closed. `public.user_roles` is the only source: deleting a user's row is how a role is
 * revoked, so a fallback to the JWT's `app_metadata.role` claim would answer every revocation with
 * the privilege the user held before it. Do not reintroduce a claim-based path here or in any
 * caller.
 */
export async function resolveUserRole(
  // deno-lint-ignore no-explicit-any -- callers pass clients created without a schema type
  client: SupabaseClient<any, any, any>,
  userId: string,
): Promise<string | null> {
  try {
    return await lookUpUserRole(client, userId);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * The same lookup for a caller that must tell "no role" from "could not tell" (`studio-admission`,
 * whose listener falls back to the token's claim on a 5xx): a failed query throws instead of
 * answering null.
 */
export async function lookUpUserRole(
  // deno-lint-ignore no-explicit-any -- callers pass clients created without a schema type
  client: SupabaseClient<any, any, any>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("user_roles")
    .select("roles(name)")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(`role lookup failed for user ${userId}: ${error.message}`);

  const dbRole = (data as { roles?: { name?: string } } | null)?.roles?.name;
  return typeof dbRole === "string" ? dbRole : null;
}
