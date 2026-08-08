/**
 * The RBAC role lookup, shared by every edge function that makes an authorisation decision.
 *
 * WHY THIS FILE CAN EXIST. It was previously copied into each function, on the stated reasoning
 * that "an edge-runtime worker can only read files beneath the service path it was booted with,
 * so a sibling directory is not visible to it". That is not true of MODULE IMPORTS on
 * supabase/edge-runtime: `servicePath` decides which directory is BOOTED, not what that module
 * graph may import. Verified against v1.74.2 by booting a function that imports from this
 * directory; both delivery paths already ship the whole tree, so the file is present either way
 * (Compose bind-mounts `./supabase/functions`, and the Dockerfile does `COPY supabase/functions`).
 *
 * It remains true for reading FILES at runtime, which is a different mechanism and a different
 * permission — `deploy-nodered` still takes the canonical flow through an environment variable
 * rather than off disk, and that comment is not superseded by this one.
 *
 * WHY THIS MATTERS MORE THAN DE-DUPLICATION. Five copies of a function that decides whether a
 * caller is an Administrator is five places for them to disagree, with no test that would notice —
 * and the failure mode of a divergent copy is a privilege decision made differently by one
 * endpoint than by the rest. The two mirrors that genuinely cannot be shared (`sparkplugToXsd`,
 * `model3dContentType`, which are duplicated with the FRONTEND, across a browser bundle) keep
 * their drift checks in `test_aas_export.py`. This one no longer needs a drift check because there
 * is nothing left to drift.
 *
 * `_shared` is not itself reachable as a function: `main/index.ts` resolves a request path against
 * FUNCTION_REGISTRY and answers 404 for anything not named there, so adding a directory here does
 * not add an endpoint.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/**
 * Resolve a user's role name from `public.user_roles`, or null.
 *
 * THE CLIENT IS THE CALLER'S DECISION, DELIBERATELY. This takes a client rather than building one,
 * because which identity performs the read is a per-function security choice and must stay visible
 * at each call site:
 *
 *   * `approve-quarantine`, `deploy-nodered` and `aas-export` pass a client bound to the CALLER's
 *     token, so RLS applies and the lookup cannot see more than the caller could.
 *   * `grafana-userinfo` and `nodered-userinfo` pass a service-role client, because the caller is
 *     an OAuth client rather than a session and the user id has already been authenticated above —
 *     making this a lookup, not an authorisation decision. Reading through the caller there would
 *     couple the endpoint to the exact shape of `user_roles_select_own_or_privileged`.
 *
 * Hiding that choice behind a convenience wrapper is how a service-role read ends up somewhere
 * nobody intended, so there is no such wrapper.
 *
 * A FAILED LOOKUP RETURNS null, NOT AN ERROR, and every caller treats null as "no role" and fails
 * closed. That is the point: an error is not evidence of a privilege.
 *
 * `public.user_roles` IS THE ONLY SOURCE, AND AN ABSENT ROW MEANS NO ROLE. Every copy of this
 * once fell back to the `app_metadata.role` claim in the caller's JWT when the lookup produced
 * nothing, on the reasoning that `handle_new_user()` writes both. That inverted the meaning of a
 * revocation: deleting a user's `user_roles` row IS how a role is revoked, so the fallback
 * answered every revocation with the privilege the user held before it, for as long as their
 * existing token remained valid. RLS was unaffected — `public.has_role()` reads the table — so the
 * database and the edge functions disagreed about who was privileged, which is the worst available
 * outcome. Do not reintroduce a claim-based path here or in any caller.
 *
 * The query error is honoured rather than discarded for the same reason. Both failure modes return
 * null; callers answer 401/403, or omit the role entirely where a consumer's own strict-mode check
 * should refuse the login.
 */
export async function resolveUserRole(
  client: SupabaseClient<any, any, any>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("user_roles")
    .select("roles(name)")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error(`role lookup failed for user ${userId}: ${error.message}`);
    return null;
  }

  const dbRole = (data as { roles?: { name?: string } } | null)?.roles?.name;
  return typeof dbRole === "string" ? dbRole : null;
}
