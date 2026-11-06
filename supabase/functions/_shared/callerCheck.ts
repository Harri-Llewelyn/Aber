/**
 * Whether PostgREST accepts the caller's token, for a function that reads as its caller: one call
 * with the caller's Authorization to `auth_probe()`, which `authenticated` alone may run, after
 * auth_pre_request() has refused anything revoked or ended. Not GoTrue's getUser(), which refuses a
 * machine identity's token because it carries no `aud`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Declared by migration 0224; check 184 of check-docs-drift.mjs reads this line. */
export const AUTH_PROBE = "auth_probe";

/**
 * `refused` is PostgREST's 401 or 403, which the caller answers with its own 401. Otherwise the
 * token could not be checked: a server fault, never an acceptance.
 */
export type CallerCheck =
  | { accepted: true }
  | { accepted: false; refused: boolean; reason: string };

export async function checkCaller(
  // deno-lint-ignore no-explicit-any -- callers pass clients created without a schema type
  client: SupabaseClient<any, any, any>,
): Promise<CallerCheck> {
  const { data, error, status } = await client.rpc(AUTH_PROBE, {}, { get: true });
  if (!error && data === true) return { accepted: true };
  if (status === 401 || status === 403) {
    const message = error?.message ?? "";
    // What PostgREST says when the role may not run the probe: the bearer named no person or
    // machine identity (a key, or nothing PostgREST could read as a token).
    const reason = !message || message.startsWith("permission denied")
      ? "a person's or a machine identity's access token is required"
      : message;
    return { accepted: false, refused: true, reason };
  }
  return {
    accepted: false,
    refused: false,
    reason: error?.message ?? `the probe answered ${status} without true`,
  };
}
