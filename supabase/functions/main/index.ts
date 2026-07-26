import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const functionName = pathParts[0];

  if (!functionName) {
    return new Response(
      JSON.stringify({ error: "Missing function name" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const workerPath = `../${functionName}/index.ts`;
    const mod = await import(workerPath);
    if (mod && typeof mod.default === "function") {
      return await mod.default(req);
    }
  } catch (_err) {
    // Fallback import
  }

  return new Response(
    JSON.stringify({ error: `Edge Function '${functionName}' not found` }),
    { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
