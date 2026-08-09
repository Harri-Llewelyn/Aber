/**
 * CORS headers for the edge functions — deliberately WITHOUT `Access-Control-Allow-Origin`.
 *
 * THE ORIGIN POLICY BELONGS TO KONG, AND ONLY TO KONG. `supabase/kong.yml` runs the `cors` plugin
 * with an explicit four-origin allow-list and `credentials: true`. Every function here previously
 * also declared `"Access-Control-Allow-Origin": "*"`, which read as the gateway and the services
 * behind it stating contradictory policies.
 *
 * Measured against the running stack before changing anything, because "which header does the
 * browser actually get" is not answerable by reading either file:
 *
 *   Origin: http://localhost:3000   ->  access-control-allow-origin: http://localhost:3000
 *   Origin: https://evil.example    ->  (header absent)
 *   OPTIONS preflight, bad origin   ->  answered BY KONG, header absent
 *
 * Kong's plugin SETS the response header in its header_filter, replacing whatever the upstream
 * sent, and answers preflight itself rather than forwarding it. So the wildcard never reached a
 * browser on any path — it was dead code that looked like policy, which is worse than no code at
 * all, because a reader has to work out which of the two statements is in force.
 *
 * WHY DELETED RATHER THAN SYNCHRONISED. Deriving the allow-list here from the same source as
 * kong.yml was the obvious fix and is the wrong one: it creates a second place stating the policy,
 * to be kept in step by a check — the exact arrangement this repository adds drift guards to
 * survive. There is no drift to guard when there is one statement. The gateway is also the only
 * layer that CAN enforce it: it is the only one that sees the request before deciding to route it.
 *
 * WHEN THIS WOULD NEED REVISITING: only if the edge runtime were ever exposed to a browser
 * directly. It is not, on either target — `supabase-functions` publishes no host port under
 * Compose and is a ClusterIP behind Kong on Kubernetes. Exposing it would need this file to grow
 * an origin policy AND would move the security boundary, so it is not a change to make quietly.
 *
 * `Access-Control-Allow-Headers` is retained because it costs nothing and is the correct answer on
 * a direct preflight. Note that without an accompanying `Allow-Origin` a browser rejects such a
 * response — which is the intended fail-closed behaviour, not an oversight.
 */
export const corsHeaders = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
