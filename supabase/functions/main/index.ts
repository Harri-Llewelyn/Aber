/**
 * Edge Function router (main service).
 *
 * supabase/edge-runtime does NOT execute functions via in-process `import()`.
 * Each function must be spawned as an isolated user worker via
 * EdgeRuntime.userWorkers.create(), then handed the request. A previous version
 * of this file used `await import("../<name>/index.ts")` inside a bare try/catch,
 * which always failed and reported a misleading
 * `404 "Edge Function '<name>' not found"` while logging nothing -- surfacing in
 * the browser as the opaque "Edge Function returned a non-2xx status code".
 *
 * Because each function runs in its own isolate, every function keeps its own
 * `serve(handler)` entry point; that is required, not redundant.
 *
 * Note on auth: this stack runs with VERIFY_JWT="false" because each function
 * performs its own role check (Administrator / Shopfloor_Manager) and fails
 * closed. The gateway therefore does no JWT pre-verification here.
 */

import { corsHeaders } from "../_shared/cors.ts";

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

/**
 * Environment every worker needs regardless of what it does: how to reach Supabase, and the
 * anon key, which is public by construction.
 *
 * SUPABASE_SERVICE_ROLE_KEY is deliberately NOT here. It is granted per function below, to the
 * three that genuinely need to act outside the caller's RLS context.
 */
const COMMON_ENV = ["SUPABASE_URL", "SUPABASE_ANON_KEY"];

/**
 * The function allow-list, and the secrets each function may see.
 *
 * WHY AN ALLOW-LIST. `serviceName` comes from the request path. Without this map, any directory
 * under /home/deno/functions was bootable by name -- including one added later whose author
 * forgot the role check. Kong does not pre-verify the JWT for this service
 * (VERIFY_JWT="false"), so "reachable" means reachable by anyone who can reach the gateway.
 * An unknown name must be a 404 decided here, not a worker that starts and then decides.
 *
 * WHY PER-FUNCTION ENV. This router previously forwarded `Deno.env.toObject()` -- the COMPLETE
 * environment -- to every worker it spawned. That handed SUPABASE_SERVICE_ROLE_KEY,
 * NODERED_ADMIN_TOKEN, POSTGRES_PASSWORD and GRAFANA_OAUTH_CLIENT_SECRET to every function
 * whether or not it had any use for them, so a single compromised or careless function leaked
 * the credentials of all the others. Each entry below lists only what that function reads.
 *
 * Adding a function means adding it here. That is the intended friction: it is the one place
 * where "what may this code reach" is stated.
 */
const FUNCTION_REGISTRY: Record<string, string[]> = {
  // Writes to `devices` outside the caller's RLS context after checking the caller's role.
  "approve-quarantine": ["SUPABASE_SERVICE_ROLE_KEY"],

  // Reads the committed flow from the environment and pushes it to Node-RED's admin API.
  // No service-role key: it makes no privileged database write.
  "deploy-nodered": ["NODERED_URL", "NODERED_ADMIN_TOKEN", "NODERED_FLOW_JSON"],

  // Mints a VIRTUAL gateway's broker credential and reveals it once. The mirror of enroll-gateway:
  // that one has no user and is authorised by a single-use token; this one has a session and is
  // authorised by role, through a SECURITY DEFINER RPC that checks has_role() itself (0041).
  //
  // NO SERVICE-ROLE KEY, WHICH IS THE POINT OF THE ENTRY. It holds the credential service's bearer
  // token and nothing else -- and that token's whole authority is "add one confined account to a
  // password file", which is narrower than any other way of reaching the broker. It cannot read a
  // table, cannot write outside the caller's RLS context, and cannot see another function's
  // secrets. gateway-bundle holds nothing at all; this cannot match that, because the password file
  // is not reachable from SQL, and the registry is where that difference is stated rather than
  // discovered.
  "gateway-credential": ["MQTT_CREDENTIAL_SERVICE_URL", "MQTT_CREDENTIAL_SERVICE_TOKEN"],

  // Physical gateway enrolment. THE ONLY FUNCTION HERE WITH NO USER, by construction: the caller is
  // an appliance holding a single-use token, and possession of that token is the authorisation. It
  // holds the service-role key because the token table is reachable by nothing else (RLS on, no
  // policies), and the credential service's bearer token because minting the broker account is the
  // point. Both are narrow: the token is short-lived and bound to one gateway, and the credential
  // service can only add an account to a password file.
  //
  // MQTT_PUBLIC_HOST is here because the response tells an appliance where to connect, and that
  // address cannot be derived from SUPABASE_URL -- inside this network that is supabase-kong, which
  // resolves for nothing on a shopfloor.
  "enroll-gateway": [
    "SUPABASE_SERVICE_ROLE_KEY",
    "MQTT_CREDENTIAL_SERVICE_URL",
    "MQTT_CREDENTIAL_SERVICE_TOKEN",
    "MQTT_PUBLIC_HOST",
    "MQTT_PUBLIC_TLS_PORT",
  ],

  // Rotates a decommissioned gateway's broker account to a password nobody records, which is how
  // this platform revokes -- the credential service is add-only by design (0038).
  //
  // CALLED BY THE DATABASE, not by a browser. A trigger on `gateways` reaches it through Kong with
  // pg_net, because the NetworkPolicy admits only `supabase-functions` to the credential service
  // and a trigger dialling that port itself would be a second edge into credential issuance.
  //
  // GATEWAY_REVOKE_SECRET must be listed here or the worker starts without it and answers 503 to
  // every revocation: envForFunction() forwards ONLY what this registry names. Same failure the
  // grafana-alert-webhook comment above describes.
  "revoke-gateway-credential": [
    "MQTT_CREDENTIAL_SERVICE_URL",
    "MQTT_CREDENTIAL_SERVICE_TOKEN",
    "GATEWAY_REVOKE_SECRET",
  ],

  // Packages the physical gateway bootstrap bundle as a ZIP.
  //
  // NO SERVICE-ROLE KEY, and that is the design rather than an omission. It reads the gateway and
  // mints the enrolment token AS THE CALLER -- issue_gateway_enrollment_token() is SECURITY
  // DEFINER and checks has_role() itself -- so this endpoint cannot produce a bundle for a gateway
  // its caller could not have produced one for. The template files arrive through the environment
  // because an edge worker cannot read the image's filesystem; SUPABASE_PUBLIC_URL is the address
  // the APPLIANCE will dial, which cannot be derived from the in-network SUPABASE_URL.
  "gateway-bundle": [
    "SUPABASE_PUBLIC_URL",
    "GW_BUNDLE_COMPOSE",
    "GW_BUNDLE_DOCKERFILE",
    "GW_BUNDLE_BOOTSTRAP",
    "GW_BUNDLE_FLOWS",
    "GW_BUNDLE_README",
  ],

  // Composes an AAS shell. Needs the service-role key to read across the tables a shell
  // aggregates, plus the identifiers and endpoints the document embeds.
  "aas-export": [
    "SUPABASE_SERVICE_ROLE_KEY",
    "AAS_BASE_IRI",
    "AAS_HISTORIAN_ENDPOINT",
    "AAS_MODEL_PUBLIC_BASE",
    "AAS_MAX_BUNDLED_MODEL_BYTES",
    "STORAGE_MODEL_BUCKET",
  ],

  // The IDTA 02001/02002 read surface over the same mapping aas-export uses.
  //
  // NO SERVICE-ROLE KEY, AND THE CONTRAST WITH THE ENTRY ABOVE IS THE POINT. aas-export composes a
  // document on request and hands it to a caller whose role it has already checked; this is a live
  // API over the whole asset space, so it authenticates and then reads AS THE CALLER and lets RLS
  // answer. Granting the key here would turn every authenticated user's submodel lookup into a
  // privileged one -- the same argument fplus-directory's entry below makes.
  //
  // IT IS ALSO WHY THESE ARE TWO FUNCTIONS RATHER THAN TWO ROUTES. envForFunction() forwards only
  // what a function's entry names, so one worker cannot hold a key the other is denied; sharing a
  // service path would mean sharing the environment, and the separation would become a convention
  // instead of a boundary.
  //
  // The AAS_* set is duplicated deliberately: the identifiers this serves must be the identifiers
  // aas-export mints, and they are derived from these variables. A deployment that set them for one
  // worker and not the other would publish shells under one namespace and fail to resolve them
  // under the other. No STORAGE_MODEL_BUCKET or AAS_MAX_BUNDLED_MODEL_BYTES: both belong to AASX
  // packaging, which this does not serve.
  "aas-api": [
    "AAS_BASE_IRI",
    "AAS_HISTORIAN_ENDPOINT",
    "AAS_MODEL_PUBLIC_BASE",
  ],

  // Records a Grafana alert notification in public.platform_alerts.
  //
  // TWO KEYS, AND THE ASYMMETRY IS THE WHOLE DESIGN. It holds the service-role key because it
  // writes to a table whose only write policy is service_role -- but the CALLER never sees that
  // key. Grafana presents GRAFANA_ALERT_WEBHOOK_SECRET, this function verifies it, and only then
  // does it use its own privileged client. Giving Grafana the service-role key directly would hand
  // a browser-SSO-fronted service the credential that bypasses RLS and can rewrite
  // digital_thread -- the same shape as the `postgres` datasource credential that was removed.
  //
  // The secret must be listed here or the worker starts without it, and the function then answers
  // 503 to every notification: envForFunction() forwards ONLY what this registry names.
  "grafana-alert-webhook": [
    "SUPABASE_SERVICE_ROLE_KEY",
    "GRAFANA_ALERT_WEBHOOK_SECRET",
  ],

  // Resolves a role from public.user_roles for Grafana's OIDC `api_url`.
  "grafana-userinfo": ["SUPABASE_SERVICE_ROLE_KEY"],

  // The same lookup for Node-RED, answering in Node-RED's permission vocabulary ('*' / 'read')
  // rather than Grafana's org roles. Separate from grafana-userinfo because the mapping is an
  // authorisation decision, and one endpoint serving both would let a change made for one
  // product's role model silently move the other's.
  "nodered-userinfo": ["SUPABASE_SERVICE_ROLE_KEY"],

  // Factory+ Directory adapter. NO SERVICE-ROLE KEY, and that is the point: it is a live read
  // API over the whole address space, so it authenticates the caller and then queries AS them,
  // letting RLS decide what they see. Granting the service key here would turn every
  // authenticated user's directory lookup into a privileged one. The common env is all it needs.
  "fplus-directory": [],
};

/**
 * Build the environment for one worker: the common set plus that function's declared secrets.
 * A declared variable that is unset in this deployment is skipped rather than forwarded as an
 * empty string, so a function's own "is it configured" check still sees the truth.
 */
function envForFunction(serviceName: string): string[][] {
  const allowed = [...COMMON_ENV, ...(FUNCTION_REGISTRY[serviceName] ?? [])];
  const env: string[][] = [];

  for (const key of allowed) {
    const value = Deno.env.get(key);
    if (value !== undefined) env.push([key, value]);
  }

  return env;
}

// Declared by the edge-runtime host.
declare const EdgeRuntime: {
  userWorkers: {
    create(opts: {
      servicePath: string;
      memoryLimitMb: number;
      workerTimeoutMs: number;
      noModuleCache: boolean;
      importMapPath: string | null;
      envVars: string[][];
    }): Promise<{ fetch(req: Request): Promise<Response> }>;
  };
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Kong routes /functions/v1/<name> with strip_path, so pathname is "/<name>".
  const { pathname } = new URL(req.url);
  const serviceName = pathname.split("/")[1];

  if (!serviceName) {
    return new Response(
      JSON.stringify({ error: "Missing function name" }),
      { status: 400, headers: jsonHeaders }
    );
  }

  // Refuse anything not on the allow-list before a worker is spawned. Answering 404 (rather
  // than 403) discloses nothing about which names exist.
  if (!Object.hasOwn(FUNCTION_REGISTRY, serviceName)) {
    console.warn(`rejected request for unregistered function '${serviceName}'`);
    return new Response(
      JSON.stringify({ error: `Function '${serviceName}' not found` }),
      { status: 404, headers: jsonHeaders }
    );
  }

  const servicePath = `/home/deno/functions/${serviceName}`;
  console.log(`serving the request with ${servicePath}`);

  const envVars = envForFunction(serviceName);

  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: 150,
      workerTimeoutMs: 60 * 1000,
      noModuleCache: false,
      importMapPath: null,
      envVars,
    });

    return await worker.fetch(req);
  } catch (err) {
    // Report the real failure. Never mask it as a 404 -- that is what made the
    // original bug undiagnosable from both the logs and the browser.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`failed to boot worker for '${serviceName}': ${message}`);

    return new Response(
      JSON.stringify({ error: `Failed to invoke '${serviceName}'`, details: message }),
      { status: 500, headers: jsonHeaders }
    );
  }
});
