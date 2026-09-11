/**
 * CORS headers for the edge functions, deliberately without `Access-Control-Allow-Origin`. The
 * origin policy belongs to the gateway alone: its `cors` plugin carries the allow-list, sets the
 * response header in its header filter and answers preflight itself, so a wildcard here never
 * reaches a browser and would only read as a contradicting policy. The edge runtime is not exposed
 * to a browser directly on either target. `Access-Control-Allow-Headers` is retained as the correct
 * answer on a direct preflight; without an accompanying `Allow-Origin` a browser rejects such a
 * response, which is the intended fail-closed behaviour.
 */
export const corsHeaders = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
