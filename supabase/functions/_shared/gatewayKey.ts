/**
 * The credential an edge function presents to the GATEWAY when it calls back through it.
 *
 * WHY THIS EXISTS AS A SHARED HELPER. Nine of the thirteen functions read this key, and every one
 * of them uses it the same way: as the `apikey` header, with the CALLER'S OWN token in
 * Authorization so RLS still decides what they can see. Nine copies of a two-line fallback is
 * nine places to get the precedence backwards, and the precedence is the whole of the migration.
 *
 * WHAT IS BEING MIGRATED. Supabase deprecates the `anon` and `service_role` JWTs by the end of
 * 2026 and replaces them with opaque `sb_publishable_*` / `sb_secret_*` keys. The gateway accepts
 * BOTH formats simultaneously and translates the new one into the legacy JWT the upstreams still
 * require, so nothing here parses the key -- it is a string, and an opaque one serves as well as a
 * JWT. See docs/gateway-migration.md.
 *
 * PREFERRED, NOT REQUIRED. An install that has not minted the new pair leaves
 * SUPABASE_PUBLISHABLE_KEY unset and keeps working on the legacy key. That fallback is what lets
 * consumers move one at a time instead of on a flag day, and removing it is a later, deliberate
 * step -- the one that actually retires the legacy format.
 *
 * NOT THE SECRET KEY. `sb_secret_*` is the replacement for `service_role`, which the router grants
 * to three functions only (see main/index.ts). Nothing in here should reach for it: this is the
 * public half, and a function that needs to act outside the caller's RLS context is asking a
 * different question.
 */
/**
 * TRUTHINESS, NOT `??`, and the difference is not style. `??` falls back only on null/undefined,
 * and both substituters set SUPABASE_PUBLISHABLE_KEY to the EMPTY STRING on a legacy-only install
 * rather than leaving it unset. With `??` that empty value would win, and every function would
 * present an empty `apikey` -- refused at the gate with "No API key found in request", on exactly
 * the deployments the fallback exists to protect.
 */
export function gatewayKey(): string {
  return (
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
    Deno.env.get("SUPABASE_ANON_KEY") ||
    ""
  );
}
