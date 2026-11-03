/**
 * Whether the data layer accepts the caller's token, for a function that reads as its caller (aas-api,
 * fplus-directory). One PostgREST call made with the caller's own Authorization, to `auth_probe()`,
 * which `authenticated` alone may run: it succeeds only when PostgREST verifies the token and
 * auth_pre_request() finds neither it, its identity nor its session withdrawn. A person's session
 * and a machine identity's token both pass. GoTrue's getUser() is not used: it refuses a token with
 * no `aud` claim, and a machine identity's token carries none.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** The probe's name. supabase/migrations/0224 declares it; check 184 of check-docs-drift.mjs reads it. */
export const AUTH_PROBE = "auth_probe";

/**
 * `accepted`, or why not. `refused` is a refusal of the token (PostgREST's 401 or 403), which the
 * caller answers with its own 401; otherwise the token could not be checked, which is a server fault
 * and never an acceptance.
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
