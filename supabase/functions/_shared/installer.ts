import { platformPublicUrl } from "./publicAddresses.ts";

/**
 * Whether this deployment may serve the one-liner's installer at all, and why not. Shared by
 * gateway-install (which serves it) and gateway-bundle (which mints the command), so a command
 * is never minted for a route that would refuse it.
 *
 * HTTPS or nothing: the token and the credential secret cross the installer route, so a public
 * URL that is plain HTTP is refused, unless ABER_INSTALLER_ALLOW_HTTP says otherwise, which the
 * development values do and nothing else should.
 */
export function installerTransport(): { ok: boolean; reason: string | null; publicUrl: string } {
  const platform = platformPublicUrl();
  if (platform.problem) return { ok: false, reason: `SUPABASE_PUBLIC_URL is ${platform.problem}`, publicUrl: platform.value };
  const allowHttp = (Deno.env.get("ABER_INSTALLER_ALLOW_HTTP") ?? "").toLowerCase() === "true";
  if (!platform.value.startsWith("https://") && !allowHttp) {
    return {
      ok: false,
      reason: `SUPABASE_PUBLIC_URL is plain HTTP (${platform.value}); the installer carries a token and a secret and is served over TLS only`,
      publicUrl: platform.value,
    };
  }
  return { ok: true, reason: null, publicUrl: platform.value };
}
