/**
 * Edge Function router (main service). supabase/edge-runtime does not execute functions via
 * in-process `import()`; each function is spawned as an isolated user worker via
 * EdgeRuntime.userWorkers.create() and handed the request, so every function keeps its own
 * `serve(handler)` entry point. This stack runs with VERIFY_JWT="false" because each function
 * performs its own role check and fails closed.
 */

import { corsHeaders } from "../_shared/cors.ts";

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

/**
 * Environment every worker needs: how to reach Supabase, and the publishable key, which is
 * public by construction. SUPABASE_SERVICE_ROLE_KEY is not here: it is granted per function
 * below.
 */
const COMMON_ENV = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"];

/**
 * The function allow-list, and the secrets each function may see. An allow-list because
 * `serviceName` comes from the request path and the gateway does not pre-verify the JWT, so an
 * unknown name must be a 404 decided here. Per-function env because forwarding the whole
 * environment would hand every function every other function's secrets. Adding a function means
 * adding it here; this is the one place "what may this code reach" is stated.
 */
const FUNCTION_REGISTRY: Record<string, string[]> = {
  // Writes to `devices` outside the caller's RLS context after checking the caller's role.
  "approve-quarantine": ["SUPABASE_SERVICE_ROLE_KEY"],

  // Reads the committed flow from the environment and pushes it to Node-RED's admin API.
  // No service-role key: it makes no privileged database write.

  // Mints a virtual gateway's broker credential and reveals it once, authorised by role through a
  // SECURITY DEFINER RPC that checks has_role() itself. No service-role key: it holds the
  // credential service's bearer token, whose authority is one confined account at the broker.
  "gateway-credential": ["MQTT_CREDENTIAL_SERVICE_URL", "MQTT_CREDENTIAL_SERVICE_TOKEN"],

  // Reads the broker's accounts and roles for the Access Control page, Administrator only. The
  // same bearer token, because the credential service is the one thing that speaks to the broker's
  // plugin; the read returns names, roles and state and no hash material.
  "broker-inventory": ["MQTT_CREDENTIAL_SERVICE_URL", "MQTT_CREDENTIAL_SERVICE_TOKEN"],

  // Signs a long-lived JWT for a service principal and reveals it once. JWT_SECRET is the widest
  // secret in this map: it signs anything, including a `service_role` token that storage, realtime,
  // the edge runtime and Studio accept without consulting the denylist. It is signed here rather
  // than in the database because the runtime already holds the key, and moving it into SQL would
  // turn every path to SQL execution into a path to an unrevocable credential. No service-role key:
  // record_service_token_issued() is SECURITY DEFINER and re-checks the actor.
  "mint-service-token": ["JWT_SECRET"],

  // Physical gateway enrolment, the only function here with no user: the caller is an appliance
  // holding a single-use token. It holds the service-role key because the token table is reachable
  // by nothing else, and the credential service's bearer token to mint the broker account.
  // MQTT_PUBLIC_HOST is the address an appliance connects to, which cannot be derived from the
  // in-network SUPABASE_URL. The forge credential authenticates as a machine account that is not a
  // Gitea administrator: it can create a gateway repository, attach a deploy key and the branch
  // rules that confine it, and nothing else. All three forge variables or none; a variable omitted here looks to the function
  // like a deployment that chose not to run a forge.
  "enroll-gateway": [
    "SUPABASE_SERVICE_ROLE_KEY",
    "MQTT_CREDENTIAL_SERVICE_URL",
    "MQTT_CREDENTIAL_SERVICE_TOKEN",
    "MQTT_PUBLIC_HOST",
    "MQTT_PUBLIC_TLS_PORT",
    "GITEA_INTERNAL_URL",
    "GITEA_MACHINE_USER",
    "GITEA_MACHINE_PASSWORD",
    // The push webhook enrolment registers on each repository (0095): where Gitea should deliver,
    // and the secret it signs with. Both optional -- unset means no hook, and enrolment says so.
    "GITEA_WEBHOOK_URL",
    "GITEA_WEBHOOK_SECRET",
    // The platform's version: the tag a new gateway's platform.yml points at, and the platform
    // repository the same key is registered read-only on. Unset means no platform repository.
    "ACS_PLATFORM_VERSION",
  ],

  // Disables a decommissioned gateway's broker account, dropping its live session, which is how
  // this platform revokes. Called by the database through the gateway with pg_net, because the
  // NetworkPolicy admits only `supabase-functions` to the credential service. GATEWAY_REVOKE_SECRET
  // must be listed here or the worker answers 503 to every revocation.
  "revoke-gateway-credential": [
    "MQTT_CREDENTIAL_SERVICE_URL",
    "MQTT_CREDENTIAL_SERVICE_TOKEN",
    "GATEWAY_REVOKE_SECRET",
  ],

  // Packages the physical gateway bootstrap bundle as a ZIP. No service-role key: it reads the
  // gateway and mints the enrolment token as the caller, through a SECURITY DEFINER function that
  // checks has_role() itself. The template files arrive through the environment because an edge
  // worker cannot read the image's filesystem; SUPABASE_PUBLIC_URL is the address the appliance
  // will dial. MQTT_PUBLIC_HOST is enroll-gateway's, forwarded here too so the readiness probe
  // (GET) can report both addresses.
  "gateway-bundle": [
    "SUPABASE_PUBLIC_URL",
    "MQTT_PUBLIC_HOST",
    "GW_BUNDLE_COMPOSE",
    "GW_BUNDLE_DOCKERFILE",
    "GW_BUNDLE_BOOTSTRAP",
    "GW_BUNDLE_FLOWS",
    "GW_BUNDLE_FLOW_SYNC",
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

  // The IDTA 02001/02002 read surface over the same mapping aas-export uses. No service-role key: a
  // live API over the whole asset space reads as the caller and lets RLS answer. Two functions
  // rather than two routes, because envForFunction() forwards only what an entry names, so one
  // worker cannot hold a key the other is denied. The AAS_* set is duplicated so the identifiers
  // this serves are the identifiers aas-export mints; no STORAGE_MODEL_BUCKET or
  // AAS_MAX_BUNDLED_MODEL_BYTES, which belong to AASX packaging.
  "aas-api": [
    "AAS_BASE_IRI",
    "AAS_HISTORIAN_ENDPOINT",
    "AAS_MODEL_PUBLIC_BASE",
  ],

  // Records a Grafana alert notification in public.platform_alerts. It holds the service-role key
  // because the table's only write policy is service_role, but the caller never sees that key:
  // Grafana presents GRAFANA_ALERT_WEBHOOK_SECRET, which must be listed here or the worker answers
  // 503 to every notification.
  "grafana-alert-webhook": [
    "SUPABASE_SERVICE_ROLE_KEY",
    "GRAFANA_ALERT_WEBHOOK_SECRET",
  ],

  // Resolves a role from public.user_roles for Grafana's OIDC `api_url`.
  "grafana-userinfo": ["SUPABASE_SERVICE_ROLE_KEY"],

  // The same lookup for Node-RED, answering in Node-RED's permission vocabulary ('*' / 'read').
  // Separate from grafana-userinfo because the mapping is an authorisation decision per product.
  "nodered-userinfo": ["SUPABASE_SERVICE_ROLE_KEY"],
  // The forge listener's ext_authz step (0094): the role from user_roles, the placement through
  // the machine account. The same three forge variables enroll-gateway holds, for the same reason.
  "forge-membership": [
    "SUPABASE_SERVICE_ROLE_KEY",
    "GITEA_INTERNAL_URL",
    "GITEA_MACHINE_USER",
    "GITEA_MACHINE_PASSWORD",
  ],
  // Gitea's own sign-out link, routed here by the forge listener: ends every GoTrue session the
  // caller holds, then sends the browser through the door's sign-out. Needs the service key to
  // revoke.
  "forge-signout": ["SUPABASE_SERVICE_ROLE_KEY"],
  // Gitea's push webhook: verifies the delivery's HMAC against GITEA_WEBHOOK_SECRET, records the
  // head of main on the gateway row, and reads flows.json at that head through the machine account
  // for its hash.
  "forge-events": [
    "SUPABASE_SERVICE_ROLE_KEY",
    "GITEA_WEBHOOK_SECRET",
    "GITEA_INTERNAL_URL",
    "GITEA_MACHINE_USER",
    "GITEA_MACHINE_PASSWORD",
  ],
  // The forge reconciled on a timer (0099): pg_cron asks through the gateway with
  // FORGE_SWEEP_SECRET, and the function walks the teams and repositories through the machine
  // account. The webhook pair is what lets it re-register a hook a repository lost. The version
  // is what it publishes the platform playbook under; the playbook itself is a module import.
  "forge-sweep": [
    "SUPABASE_SERVICE_ROLE_KEY",
    "FORGE_SWEEP_SECRET",
    "GITEA_INTERNAL_URL",
    "GITEA_MACHINE_USER",
    "GITEA_MACHINE_PASSWORD",
    "GITEA_WEBHOOK_URL",
    "GITEA_WEBHOOK_SECRET",
    "ACS_PLATFORM_VERSION",
  ],

  // Factory+ Directory adapter. No service-role key: it authenticates the caller and queries as
  // them, letting RLS decide what they see. The common env is all it needs.
  "fplus-directory": [],
};

/**
 * Build the environment for one worker: the common set plus that function's declared secrets. A
 * declared variable that is unset is skipped rather than forwarded as an empty string, so a
 * function's own configuration check sees the truth.
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

  // The gateway routes /functions/v1/<name> with the prefix stripped, so pathname is "/<name>".
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
