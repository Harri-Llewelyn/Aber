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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

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

  const servicePath = `/home/deno/functions/${serviceName}`;
  console.log(`serving the request with ${servicePath}`);

  const envVarsObj = Deno.env.toObject();
  const envVars = Object.keys(envVarsObj).map((k) => [k, envVarsObj[k]]);

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
