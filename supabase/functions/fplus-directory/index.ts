import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Factory+ Directory adapter: the read half of the Factory+ Directory component's REST contract,
 * projected from the tables this platform already has. It is not the AMRC Directory service: it
 * does not consume Sparkplug births, has no change-notify metrics, and registers with no
 * Configuration Store.
 *
 * Identity mapping: Instance_UUID is devices.id / gateways.id; the Sparkplug address is
 * (sparkplug_group, sparkplug_id); Schema_UUID is schemas.id and Service_UUID is
 * directory_services.id, both locally minted (see the note on /v1/schema).
 *
 * `/ping` is unauthenticated because the specification requires it for discovery. Every `/v1/` path
 * requires a valid bearer token and fails closed: the gateway exempts this route from key-auth so a
 * Factory+ client with no Supabase apikey can reach it, so this file is the only thing in front of
 * the data, and the token check runs before any routing decision. It reads as the caller, not the
 * service role; there is no SUPABASE_SERVICE_ROLE_KEY in its registry entry.
 */

const SERVICE_NAME = "fplus-directory";

import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * The request path with the routing prefixes removed. The gateway routes `/v1/...` with
 * `strip_path: false` onto a service URL ending in `/fplus-directory`, so the runtime sees
 * `/fplus-directory/v1/device`; invoked through `/functions/v1/fplus-directory` the same handler
 * sees nothing after the function name.
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

/**
 * The qualification every schema identifier leaves this service wearing. One constant read by both
 * schema routes, so a local `schemas.id` is never mistaken for a registered Factory+ Schema_UUID.
 */
const LOCAL_SCHEMA_NOTE = "Locally minted schema identifiers, not registered Factory+ Schema_UUIDs.";

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = routePath(url);

  // GET /ping, unauthenticated by specification. Reports the service's identity and version and
  // nothing about the fleet.
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

  // Everything below is authenticated. Fail closed. The check is before routing, not inside each
  // branch, so a handler added later is authenticated by construction.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing Authorization header" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = gatewayKey();

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
    // GET /v1/device: every known device UUID. GET /v1/device/{uuid}: one device's address, status
    // and schemas.
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

    // GET /v1/address/{group}/{node}[/{device}]. The group is part of the address, so two groups
    // cannot collide into one row.
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
        // The edge node itself declares no schema: an NBIRTH carries the node's own metrics, not a
        // device model.
        schemas: [],
        devices: entries,
      });
    }

    // GET /v1/schema: Schema UUIDs in use. GET /v1/schema/{uuid}: which devices implement one.
    // Locally minted, and both responses say so from the same constant; handing them back
    // unqualified would assert an interoperability that does not exist.
    if (path === "/v1/schema" || path.startsWith("/v1/schema/")) {
      const requested = path === "/v1/schema" ? null : decodeURIComponent(path.slice("/v1/schema/".length));

      if (requested !== null && !UUID_RE.test(requested)) {
        // Same courtesy as /v1/device: a client that sent `schema_name` sent the wrong
        // identifier, and saying which one is right beats an empty 404.
        return json({
          error: "Schema_UUID must be an RFC4122 UUID",
          hint: "This platform's schema_name is a different identifier; GET /v1/schema lists the UUIDs in use.",
        }, 400);
      }

      if (requested) return await schemaMembers(supabase, requested);

      const { data, error } = await supabase
        .from("schemas")
        .select("id,schema_name,version,status")
        .eq("status", "active");
      if (error) return json({ error: "Schema lookup failed", details: error.message }, 500);
      return json({
        namespace: "local",
        note: LOCAL_SCHEMA_NOTE,
        schemas: (data ?? []).map((s) => ({
          uuid: s.id,
          name: s.schema_name,
          version: s.version,
        })),
      });
    }

    // GET /v1/service: advertised services.
    if (path === "/v1/service") {
      // `status` is an observation and can be UNKNOWN: ACTIVE / DOWN / UNKNOWN, written every
      // minute from Prometheus's `up` series. UNKNOWN means nothing observes that service, and is
      // passed through rather than flattened to ACTIVE so a consumer can tell "up" from "nobody is
      // looking".
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
      served: [
        "/ping",
        "/v1/device",
        "/v1/device/{uuid}",
        "/v1/address/{group}/{node}",
        "/v1/schema",
        "/v1/schema/{uuid}",
        "/v1/service",
      ],
    }, 404);
  } catch (err) {
    return json(
      { error: "Directory lookup failed", details: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

/**
 * GET /v1/schema/{uuid}: the reverse of every other lookup, from a schema to its assets. No status
 * filter, unlike the collection: the most useful case is an archived schema with devices still
 * attached, a migration that has not finished, so the status is returned instead. Devices as full
 * entries, as `/v1/address` returns them. Through the `device_schemas` view, which includes devices
 * provisioned through the legacy 1:1 `devices.schema_id`.
 */
async function schemaMembers(
  supabase: SupabaseClient,
  schemaId: string,
): Promise<Response> {
  const { data: schemas, error: schemaError } = await supabase
    .from("schemas")
    .select("id,schema_name,version,status")
    .eq("id", schemaId);
  if (schemaError) return json({ error: "Schema lookup failed", details: schemaError.message }, 500);

  const schema = (schemas ?? [])[0] as
    | { id: string; schema_name: string; version: number; status: string }
    | undefined;
  if (!schema) return json({ error: "No such schema" }, 404);

  const { data: members, error: memberError } = await supabase
    .from("device_schemas")
    .select("device_id")
    .eq("schema_id", schemaId);
  if (memberError) return json({ error: "Schema lookup failed", details: memberError.message }, 500);

  const deviceIds = [...new Set((members ?? []).map((row) => String((row as { device_id: string }).device_id)))];

  // A schema with no members is a 200 with an empty list, NOT a 404. "Nothing implements this
  // yet" is an answer, and it is the answer a client gets while a model is being rolled out.
  let entries: DirectoryEntry[] = [];
  if (deviceIds.length) {
    const { data: devices, error: deviceError } = await supabase
      .from("devices")
      .select("id,name,sparkplug_id,status,is_quarantined,gateway_id,gateways(sparkplug_id,sparkplug_group)")
      .in("id", deviceIds)
      .eq("is_archived", false);
    if (deviceError) return json({ error: "Schema lookup failed", details: deviceError.message }, 500);
    // attachSchemas re-reads the view to give each device its full set, not the set of one this
    // query filtered on.
    entries = await attachSchemas(supabase, (devices ?? []).map(deviceEntry));
  }

  return json({
    namespace: "local",
    note: LOCAL_SCHEMA_NOTE,
    uuid: schema.id,
    name: schema.schema_name,
    version: schema.version,
    // See the docblock: this is here so that an archived schema does not have to be inferred
    // from its absence somewhere else.
    status: schema.status,
    devices: entries,
  });
}

/**
 * Fill in each entry's `schemas` from the `device_schemas` view. One query for the whole set, since
 * the collection endpoint returns the entire fleet. The view, not `device_submodels`, so a device
 * provisioned through the legacy 1:1 column reports the same set the exporter and the frontend see.
 */
async function attachSchemas(
  supabase: SupabaseClient,
  entries: DirectoryEntry[],
): Promise<DirectoryEntry[]> {
  if (!entries.length) return entries;

  const { data, error } = await supabase
    .from("device_schemas")
    .select("device_id,schema_id")
    .in("device_id", entries.map((e) => e.uuid));

  // Non-fatal: a device's address and status are still worth returning if the schema join fails,
  // and reporting no schemas is honest.
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
    // A quarantined device is in the directory: it exists on the wire, and the flag says why its
    // telemetry is not being stored.
    quarantined: Boolean(row.is_quarantined),
    schemas: [],
  };
}

Deno.serve(handler);
