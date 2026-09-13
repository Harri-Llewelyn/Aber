/**
 * The credential an edge function presents to the gateway when it calls back through it: the
 * publishable key as `apikey`, with the caller's own token in Authorization so RLS still decides
 * what they see. Never the secret key, which is granted per function in main/index.ts.
 */
export function gatewayKey(): string {
  return Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
}
