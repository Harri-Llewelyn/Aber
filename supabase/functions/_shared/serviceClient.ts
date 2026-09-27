import { createClient } from "@supabase/supabase-js";
import { gatewayKey } from "./gatewayKey.ts";

/**
 * A client acting as `service_role`: the publishable key at the gateway, the service-role JWT as
 * the bearer. The same shape as every machine identity on the platform (the ingestion daemon,
 * the playback worker): the JWT is never the `apikey`, because the gateway refuses it there.
 */
export function serviceRoleClient(
  supabaseUrl: string,
  serviceRoleKey: string,
  headers: Record<string, string> = {},
) {
  return createClient(supabaseUrl, gatewayKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${serviceRoleKey}`, ...headers } },
  });
}
