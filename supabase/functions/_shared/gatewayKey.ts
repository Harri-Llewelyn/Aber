/**
 * The credential an edge function presents to the gateway when it calls back through it: the
 * `apikey` header, with the caller's own token in Authorization so RLS still decides what they see.
 * Supabase replaces the `anon` and `service_role` JWTs with opaque `sb_publishable_*` /
 * `sb_secret_*` keys; the gateway accepts both formats, so nothing here parses the key. See
 * docs/gateway-migration.md. The publishable key is preferred, not required: a legacy-only install
 * leaves SUPABASE_PUBLISHABLE_KEY unset and keeps working. Never the secret key, which is granted
 * per function in main/index.ts.
 */
/**
 * Truthiness, not `??`: both substituters set SUPABASE_PUBLISHABLE_KEY to the empty string on a
 * legacy-only install, and with `??` that empty value would win and every function would present an
 * empty `apikey`.
 */
export function gatewayKey(): string {
  return (
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
    Deno.env.get("SUPABASE_ANON_KEY") ||
    ""
  );
}
