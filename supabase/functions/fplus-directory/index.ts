import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/**
 * Factory+ Directory adapter.
 *
 * Serves the read half of the Factory+ Directory component's REST contract by PROJECTING the
 * tables this platform already has. Nothing upstream of this file knows the Directory exists:
 * no column, trigger or ingestion path changed to support it, exactly as `aas-export` is an
 * adapter rather than a storage format.
 *
 * WHAT IT IS NOT. This is not the AMRC Directory service. It answers the four questions an
 * upstream Factory+ client asks -- which devices exist, what is at this Sparkplug address, which
 * schemas are in use, which services are advertised -- and nothing else. It does not consume
 * Sparkplug births to build its own registry, it has no change-notify metrics, and it does not
 * register itself with a Configuration Store, because there is no ConfigDB here to register with.
 *
 * IDENTITY MAPPING, which is the whole substance of the adapter:
 *
 *   Factory+            here                      why
 *   ------------------  ------------------------  ------------------------------------------
 *   Instance_UUID       devices.id / gateways.id  already RFC4122; no second namespace needed
 *   Sparkplug address   (sparkplug_group,         migration 0008 made the group part of the
 *                        sparkplug_id)            address, which is what /v1/address needs
 *   Schema_UUID         schemas.id                LOCALLY minted -- see the note on /v1/schema
 *   Service_UUID        directory_services.id     likewise local
 *
 * AUTH. `/ping` is unauthenticated because the Factory+ component specification requires it to
 * be reachable for discovery. EVERY `/v1/` path requires a valid bearer token and fails closed:
 * Kong does not gate this route (it is exempt from key-auth so that a Factory+ client with no
 * Supabase apikey can reach it at all), so this file is the only thing standing in front of the
 * data. That inversion is why the token check happens before any routing decision.
 *
 * It reads as the CALLER, not as the service role. A Directory is a live read over the whole
 * address space, so running it with the service key would hand every authenticated user a view
 * their RLS policies do not grant them. There is deliberately no SUPABASE_SERVICE_ROLE_KEY in
 * this function's registry entry in main/index.ts.
 */

const SERVICE_NAME = "fplus-directory";

import { corsHeaders } from "../_shared/cors.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * The request path with the routing prefixes removed.
 *
 * Two prefixes have to come off, and both are real rather than defensive. Kong routes `/v1/…`
 * with `strip_path: false` onto a service URL that already ends in `/fplus-directory`, so the
 * runtime sees `/fplus-directory/v1/device` -- which is also how it learns which worker to
 * spawn (main/index.ts reads the first segment). Invoked through `/functions/v1/fplus-directory`
 * instead, the same handler sees a path with nothing after the function name.
 */
function routePath(url: URL): string {
  let path = url.pathname;
  if (path.startsWith(`/${SERVICE_NAME}`)) path = path.slice(SERVICE_NAME.length + 1);
  if (path.startsWith("/functions/v1")) path = path.slice("/functions/v1".length);
  return path.replace(/\/+$/, "") || "/";
}

/** A device or gateway rendered as a Factory+ Directory entry. */
interface DirectoryEntry {
  uuid: string;
  name: string;
  address: { group_id: string; node_id: string; device_id?: string };
  online: boolean;
  last_change?: string | null;
  schemas: string[];
  quarantined?: boolean;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = routePath(url);

  // ---------------------------------------------------------------------------------------
  // GET /ping -- unauthenticated, by specification.
  // ---------------------------------------------------------------------------------------
  // Factory+ requires every component to serve this so a client can discover what it is
  // talking to before holding a credential for it. It reports the service's identity and
  // version and NOTHING about the fleet -- no counts, no names -- so being open costs nothing.
  if (path === "/ping") {
    return json({
      service: SERVICE_NAME,
      status: "ok",
      version: "1.0.0",
      // The Factory+ Sparkplug payload marker this deployment's births carry. Advertised so a
      // client can tell it is talking to something that speaks the profile.
      factoryplus_payload_uuid: "11ad7b32-1d32-4c4a-b0c9-fa049208939a",
    });
  }

  if (req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ---------------------------------------------------------------------------------------
  // Everything below is authenticated. FAIL CLOSED.
  // ---------------------------------------------------------------------------------------
  // Kong exempts this route from key-auth, so an unauthenticated request reaches this worker.
  // The check is therefore before routing, not inside each branch -- a handler added later is
  // authenticated by construction rather than by its author remembering.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  // As the caller. Every read below runs under that user's RLS policies, which is what keeps
  // this from becoming a way around them.
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) {
    return json({ error: "Invalid user token", details: userError?.message }, 401);
  }

  try {
    // -------------------------------------------------------------------------------------
    // GET /v1/device            -> every known device UUID
    // GET /v1/device/{uuid}     -> one device's address, status and schemas
    // -------------------------------------------------------------------------------------
    if (path === "/v1/device" || path.startsWith("/v1/device/")) {
      const requested = path === "/v1/device" ? null : decodeURIComponent(path.slice("/v1/device/".length));

      if (requested && !UUID_RE.test(requested)) {
        // Factory+ addresses a device by Instance_UUID. A sparkplug_id here is a client using
        // the wrong identifier, and saying so is more useful than an empty 404.
        return json({
          error: "Instance_UUID must be an RFC4122 UUID",
          hint: "This platform's sparkplug_id is a different identifier; use /v1/address/{group}/{node}/{device} to resolve one.",
        }, 400);
      }

      let query = supabase
        .from("devices")
        .select("id,name,sparkplug_id,status,is_quarantined,gateway_id,gateways(sparkplug_id,sparkplug_group)")
        .eq("is_archived", false);
      if (requested) query = query.eq("id", requested);

      const { data, error } = await query;
      if (error) return json({ error: "Device lookup failed", details: error.message }, 500);

      const entries = await attachSchemas(supabase, (data ?? []).map(deviceEntry));

      if (requested) {
        if (!entries.length) return json({ error: "No such device" }, 404);
        return json(entries[0]);
      }
      // The bare collection is a UUID LIST, matching the Factory+ Directory's own shape --
      // a client enumerates, then fetches the ones it cares about.
      return json(entries.map((e) => e.uuid));
    }

    // -------------------------------------------------------------------------------------
    // GET /v1/address/{group}/{node}[/{device}]
    // -------------------------------------------------------------------------------------
    // The endpoint migration 0008 exists for. Before `gateways.sparkplug_group`, a node id
    // alone was the whole address and two groups collided into one row.
    if (path.startsWith("/v1/address/")) {
      const parts = path.slice("/v1/address/".length).split("/").map(decodeURIComponent);
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        return json({ error: "Expected /v1/address/{group_id}/{node_id}[/{device_id}]" }, 400);
      }
      const [groupId, nodeId, deviceId] = parts;

      const { data: gateways, error: gwError } = await supabase
        .from("gateways")
        .select("id,name,sparkplug_id,sparkplug_group,status,last_heartbeat,is_archived")
        .eq("sparkplug_group", groupId)
        .eq("sparkplug_id", nodeId)
        .eq("is_archived", false);
      if (gwError) return json({ error: "Address lookup failed", details: gwError.message }, 500);

      const gateway = (gateways ?? [])[0];
      if (!gateway) return json({ error: "No edge node at that address" }, 404);

      const { data: devices, error: devError } = await supabase
        .from("devices")
        .select("id,name,sparkplug_id,status,is_quarantined,gateway_id,gateways(sparkplug_id,sparkplug_group)")
        .eq("gateway_id", gateway.id)
        .eq("is_archived", false);
      if (devError) return json({ error: "Address lookup failed", details: devError.message }, 500);

      const entries = await attachSchemas(supabase, (devices ?? []).map(deviceEntry));

      if (deviceId) {
        const match = entries.find((e) => e.address.device_id === deviceId || e.uuid === deviceId);
        if (!match) return json({ error: "No such device at that address" }, 404);
        return json(match);
      }

      return json({
        uuid: gateway.id,
        name: gateway.name,
        address: { group_id: gateway.sparkplug_group, node_id: gateway.sparkplug_id },
        online: gateway.status === "ONLINE",
        last_change: gateway.last_heartbeat,
        // The edge node itself declares no schema -- see the NBIRTH note in node_red_flow.json
        // for why claiming Factory+'s component schema would be a false assertion.
        schemas: [],
        devices: entries,
      });
    }

    // -------------------------------------------------------------------------------------
    // GET /v1/schema -- Schema UUIDs in use
    // -------------------------------------------------------------------------------------
    // LOCALLY MINTED, and the response says so. Factory+ Schema_UUIDs are registered against
    // the AMRC schema repository; these are this deployment's own `schemas.id` values. Handing
    // them back unqualified would assert an interoperability that does not exist -- the same
    // rule the semantic-id namespace follows.
    if (path === "/v1/schema") {
      const { data, error } = await supabase
        .from("schemas")
        .select("id,schema_name,version,status")
        .eq("status", "active");
      if (error) return json({ error: "Schema lookup failed", details: error.message }, 500);
      return json({
        namespace: "local",
        note: "Locally minted schema identifiers, not registered Factory+ Schema_UUIDs.",
        schemas: (data ?? []).map((s) => ({
          uuid: s.id,
          name: s.schema_name,
          version: s.version,
        })),
      });
    }

    // -------------------------------------------------------------------------------------
    // GET /v1/service -- advertised services
    // -------------------------------------------------------------------------------------
    if (path === "/v1/service") {
      const { data, error } = await supabase
        .from("directory_services")
        .select("id,service_name,service_type,endpoint_url,status");
      if (error) return json({ error: "Service lookup failed", details: error.message }, 500);
      return json({
        namespace: "local",
        note: "Stack service endpoints, not registered Factory+ Service_UUIDs.",
        services: (data ?? []).map((s) => ({
          uuid: s.id,
          name: s.service_name,
          type: s.service_type,
          url: s.endpoint_url,
          online: s.status === "ACTIVE",
        })),
      });
    }

    return json({
      error: "Not found",
      served: ["/ping", "/v1/device", "/v1/device/{uuid}", "/v1/address/{group}/{node}", "/v1/schema", "/v1/service"],
    }, 404);
  } catch (err) {
    return json(
      { error: "Directory lookup failed", details: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

/**
 * Fill in each entry's `schemas` from the `device_schemas` view.
 *
 * ONE query for the whole set, not one per device: the collection endpoint returns the entire
 * fleet, and a per-entry lookup would be a round-trip per device on every call.
 *
 * The VIEW, not `device_submodels` -- it is the union of the join rows and the legacy 1:1
 * `devices.schema_id`, so a device provisioned either way reports the same set the exporter and
 * the frontend see. Reading the join table alone would silently report no schema for a device
 * that has one.
 */
async function attachSchemas(
  supabase: ReturnType<typeof createClient>,
  entries: DirectoryEntry[],
): Promise<DirectoryEntry[]> {
  if (!entries.length) return entries;

  const { data, error } = await supabase
    .from("device_schemas")
    .select("device_id,schema_id")
    .in("device_id", entries.map((e) => e.uuid));

  // Non-fatal, deliberately: a device's address and status are still worth returning if the
  // schema join fails. Reporting NO schemas is honest here -- the alternative is a 500 that
  // hides the rest of the answer.
  if (error) {
    console.error(`device_schemas lookup failed: ${error.message}`);
    return entries;
  }

  const byDevice = new Map<string, string[]>();
  for (const row of data ?? []) {
    const key = String((row as { device_id: string }).device_id);
    const list = byDevice.get(key) ?? [];
    list.push(String((row as { schema_id: string }).schema_id));
    byDevice.set(key, list);
  }

  for (const entry of entries) {
    entry.schemas = byDevice.get(entry.uuid) ?? [];
  }
  return entries;
}

/** Project one `devices` row (with its gateway embedded) onto a Directory entry. */
function deviceEntry(row: Record<string, unknown>): DirectoryEntry {
  const gw = (row.gateways ?? {}) as { sparkplug_id?: string; sparkplug_group?: string };
  return {
    uuid: String(row.id),
    name: String(row.name ?? ""),
    address: {
      // An unbound device has no address. Reported as empty strings rather than omitted, so a
      // client destructuring the object does not have to special-case the shape.
      group_id: gw.sparkplug_group ?? "",
      node_id: gw.sparkplug_id ?? "",
      device_id: (row.sparkplug_id as string) ?? "",
    },
    online: row.status === "ONLINE",
    // A quarantined device IS in the directory, deliberately: it exists on the wire and a
    // client that meets its traffic needs to be able to look it up. The flag says why its
    // telemetry is not being stored.
    quarantined: Boolean(row.is_quarantined),
    schemas: [],
  };
}

serve(handler);
