/**
 * aas-api: the IDTA 02001/02002 REST surface over live database state, for an ERP, PLM or MES that
 * wants one submodel now and again in ten minutes rather than a whole file. No service-role key: it
 * authenticates the caller and queries as them, so RLS decides what they see; `aas-export` holds
 * that key, which is why these are two functions with separate environments. The mapping is shared
 * with the exporter (`../_shared/aas/shell.ts`). Identifiers are derived
 * (`${BASE_IRI}${sparkplug_id}/submodel/...`), so an identifier is parsed back to a `sparkplug_id`
 * rather than looked up; changing AAS_BASE_IRI changes every identifier this deployment has
 * published. Not served: writes (the dashboard is the authoring interface, with its own audit
 * trail), inlined telemetry values (`LinkedSegment` points at the historian), and `.aasx`
 * (aas-export).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  BASE_IRI,
  buildEnvironment,
  type BuiltShell,
  loadDeviceRecord,
} from "../_shared/aas/shell.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";

const SERVICE_NAME = "aas-api";
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: jsonHeaders });

/**
 * The specification's error shape: a conformant client parses `messages[]`, not a bare `{error:
 * "..."}`.
 */
const problem = (status: number, text: string, code = String(status)) =>
  json({
    messages: [{
      messageType: "Error",
      text,
      code,
      timestamp: new Date().toISOString(),
    }],
  }, status);

// Identifiers

/**
 * base64url, as IDTA 02002 requires for every Identifier in a path: `/` in plain base64 would split
 * one identifier across two segments. Padding is stripped on encode and accepted on decode. Encoded
 * through TextEncoder because `btoa` throws above U+00FF and an IRI may carry non-ASCII.
 */
function b64urlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** A device's wire id, as `shell.ts` composes it into every identifier it mints. */
const SPARKPLUG_RE = /^dev[0-9a-f]{21}$/;

/**
 * The `sparkplug_id` an AAS identifier belongs to, or null when it is not one of ours. Accepts the
 * shell form (`<base><id>/shell`) and the submodel form (`<base><id>/submodel/<suffix>`).
 */
function assetOf(identifier: string): string | null {
  if (!identifier.startsWith(BASE_IRI)) return null;
  const rest = identifier.slice(BASE_IRI.length);
  const first = rest.split("/")[0] ?? "";
  return SPARKPLUG_RE.test(first) ? first : null;
}

// Pagination. The specification's cursor is opaque to the client: a cursor here names the next
// device, and a page is every item belonging to the devices it covers, which stays stable while the
// data changes.

const DEFAULT_LIMIT = 20;
/** Each device on a page costs seven queries and one shell construction. That is the reason. */
const MAX_LIMIT = 100;

function pageSize(url: URL): number | Response {
  const raw = url.searchParams.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return problem(400, "limit must be a positive integer", "400");
  }
  return Math.min(n, MAX_LIMIT);
}

/** `{ paging_metadata, result }`, with the cursor omitted rather than nulled on the last page. */
function paged(result: unknown[], cursor: string | null) {
  return {
    paging_metadata: cursor ? { cursor } : {},
    result,
  };
}

// ValueOnly serialisation ($value): IDTA 02002's form that strips the metamodel down to the values,
// so reading a serial number is `body.SerialNumber`.

// deno-lint-ignore no-explicit-any
function valueOnly(element: any): unknown {
  switch (element?.modelType) {
    case "Property":
      // `value` is absent, not null, for an unpublished metric -- see the rule in shell.ts. Null is
      // the honest ValueOnly rendering of that: the element exists and has no value.
      return element.value ?? null;
    case "File":
      return { contentType: element.contentType, value: element.value };
    case "SubmodelElementCollection": {
      const out: Record<string, unknown> = {};
      for (const child of element.value ?? []) out[child.idShort] = valueOnly(child);
      return out;
    }
    default:
      return element?.value ?? null;
  }
}

// deno-lint-ignore no-explicit-any
function submodelValueOnly(submodel: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const element of submodel?.submodelElements ?? []) out[element.idShort] = valueOnly(element);
  return out;
}

/**
 * Walk an `idShortPath` in the specification's dotted form (`Metrics.Systems_TEMPERATURE`). Only
 * collections are traversable; a path that runs into a Property mid-way is a 404, a client mistake
 * rather than a server fault.
 */
// deno-lint-ignore no-explicit-any
function elementAt(submodel: any, idShortPath: string): any | null {
  const segments = idShortPath.split(".").filter(Boolean);
  // deno-lint-ignore no-explicit-any
  let pool: any[] = submodel?.submodelElements ?? [];
  // deno-lint-ignore no-explicit-any
  let found: any = null;

  for (const segment of segments) {
    found = pool.find((e) => e?.idShort === segment) ?? null;
    if (!found) return null;
    pool = found.modelType === "SubmodelElementCollection" ? (found.value ?? []) : [];
  }
  return found;
}

// Routing

/** Strip whichever prefix the gateway left on, exactly as fplus-directory does. */
function routePath(url: URL): string {
  let path = url.pathname;
  if (path.startsWith(`/${SERVICE_NAME}`)) path = path.slice(SERVICE_NAME.length + 1);
  if (path.startsWith("/functions/v1")) path = path.slice("/functions/v1".length);
  return path.replace(/\/+$/, "") || "/";
}

// deno-lint-ignore no-explicit-any
type Client = any;

/** Build one device's shell, or null when no device carries that wire id. */
async function shellFor(client: Client, sparkplugId: string): Promise<BuiltShell | null> {
  const { data, error } = await client
    .from("devices")
    .select("id")
    .eq("sparkplug_id", sparkplugId)
    .eq("is_archived", false);

  if (error) throw new Error(error.message);
  const id = data?.[0]?.id;
  if (!id) return null;

  const record = await loadDeviceRecord(client, id);
  return record ? buildEnvironment(record) : null;
}

/**
 * One page of devices, keyset-paginated by `id` rather than `created_at`, so the cursor is stable
 * under insertion.
 */
async function devicePage(client: Client, limit: number, cursor: string | null) {
  let query = client
    .from("devices")
    .select("id, sparkplug_id")
    .eq("is_archived", false)
    .order("id", { ascending: true })
    // One extra row, to learn whether a next page exists without a second count query.
    .limit(limit + 1);

  if (cursor) query = query.gt("id", cursor);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { page, nextCursor: hasMore ? String(page[page.length - 1].id) : null };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = routePath(url);

  // GET /description, the service's own profile declaration. Unauthenticated by specification, so a
  // client can find out what it is talking to before it holds a credential; it reports profiles and
  // nothing about the fleet.
  if (path === "/description") {
    return json({
      profiles: [
        // SSP-002 is the READ-ONLY service specification profile in both cases. Advertising the
        // full SSP-001 would promise the write routes this deliberately does not serve.
        "https://admin-shell.io/aas/API/3/0/AssetAdministrationShellRepositoryServiceSpecification/SSP-002",
        "https://admin-shell.io/aas/API/3/0/SubmodelRepositoryServiceSpecification/SSP-002",
      ],
    });
  }

  if (req.method !== "GET") {
    // 405 rather than 404: the path may well exist, and a client that gets 404 for a POST will
    // retry the URL rather than stop writing.
    return problem(405, "This is a read-only AAS repository; only GET is served.", "405");
  }

  // Everything below is authenticated. Fail closed.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return problem(401, "Missing Authorization header", "401");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = gatewayKey();

  // As the caller. Every read below runs under that user's RLS policies, which is what keeps this
  // from becoming a way around them.
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) {
    return problem(401, "Invalid user token", "401");
  }

  try {
    const limitOrError = pageSize(url);
    if (limitOrError instanceof Response) return limitOrError;
    const limit = limitOrError;
    const cursor = url.searchParams.get("cursor");
    const wantsValue = path.endsWith("/$value");
    const bare = wantsValue ? path.slice(0, -"/$value".length) : path;

    // GET /shells: every shell this deployment publishes.
    if (bare === "/shells") {
      const { page, nextCursor } = await devicePage(supabase, limit, cursor);
      const shells = [];
      for (const row of page) {
        const built = await shellFor(supabase, String(row.sparkplug_id));
        if (built) shells.push(built.shell);
      }
      return json(paged(shells, nextCursor));
    }

    // GET /submodels: every submodel, across every shell.
    if (bare === "/submodels") {
      const { page, nextCursor } = await devicePage(supabase, limit, cursor);
      const submodels = [];
      for (const row of page) {
        const built = await shellFor(supabase, String(row.sparkplug_id));
        if (built) submodels.push(...built.submodels);
      }
      return json(paged(
        wantsValue ? submodels.map(submodelValueOnly) : submodels,
        nextCursor,
      ));
    }

    // /shells/{aasIdentifier}...
    if (bare.startsWith("/shells/")) {
      const rest = bare.slice("/shells/".length);
      const [encodedId, ...tail] = rest.split("/");

      const identifier = b64urlDecode(decodeURIComponent(encodedId));
      if (!identifier) {
        return problem(400, "aasIdentifier must be base64url-encoded", "400");
      }

      const sparkplugId = assetOf(identifier);
      if (!sparkplugId) return problem(404, `No shell with identifier '${identifier}'`, "404");

      const built = await shellFor(supabase, sparkplugId);
      if (!built) return problem(404, `No shell with identifier '${identifier}'`, "404");

      // The identifier has to match the shell we built, not merely name a device that exists --
      // otherwise `<base><id>/submodel/Nameplate` would resolve as a shell.
      if (built.shell.id !== identifier) {
        return problem(404, `No shell with identifier '${identifier}'`, "404");
      }

      if (tail.length === 0) return json(built.shell);

      if (tail[0] === "asset-information" && tail.length === 1) {
        return json(built.shell.assetInformation);
      }

      // Paginated by specification even though one asset's list is always short -- a client that
      // reads `paging_metadata` on every list must find it here too.
      if (tail[0] === "submodel-refs" && tail.length === 1) {
        return json(paged(built.shell.submodels as unknown[], null));
      }

      // GET /shells/{aasId}/submodels/{submodelId}[/...]: the same submodel routes reached through
      // the shell. The submodel must belong to this shell, which is checked here and then handed
      // on.
      if (tail[0] === "submodels" && tail.length >= 2) {
        const subIdentifier = b64urlDecode(decodeURIComponent(tail[1]));
        if (!subIdentifier) {
          return problem(400, "submodelIdentifier must be base64url-encoded", "400");
        }
        const submodel = built.submodels.find((s) => s.id === subIdentifier);
        if (!submodel) {
          return problem(404, `Shell '${identifier}' has no submodel '${subIdentifier}'`, "404");
        }
        return submodelResponse(submodel, tail.slice(2), wantsValue);
      }

      return problem(404, `Not found: ${path}`, "404");
    }

    // /submodels/{submodelIdentifier}...
    if (bare.startsWith("/submodels/")) {
      const rest = bare.slice("/submodels/".length);
      const [encodedId, ...tail] = rest.split("/");

      const identifier = b64urlDecode(decodeURIComponent(encodedId));
      if (!identifier) {
        return problem(400, "submodelIdentifier must be base64url-encoded", "400");
      }

      const sparkplugId = assetOf(identifier);
      if (!sparkplugId) return problem(404, `No submodel with identifier '${identifier}'`, "404");

      const built = await shellFor(supabase, sparkplugId);
      const submodel = built?.submodels.find((s) => s.id === identifier);
      if (!submodel) return problem(404, `No submodel with identifier '${identifier}'`, "404");

      return submodelResponse(submodel, tail, wantsValue);
    }

    // GET /: the specification defines no route index, so this answers 404 and names the routes in
    // the body, so somebody who found this URL in a config file knows what to ask for next.
    if (bare === "/") {
      return json({
        messages: [{
          messageType: "Error",
          text: "No resource at the repository root. See `served`, or GET /description.",
          code: "404",
          timestamp: new Date().toISOString(),
        }],
        served: [
          "/description",
          "/shells",
          "/shells/{aasIdentifier}",
          "/shells/{aasIdentifier}/asset-information",
          "/shells/{aasIdentifier}/submodel-refs",
          "/shells/{aasIdentifier}/submodels/{submodelIdentifier}",
          "/submodels",
          "/submodels/{submodelIdentifier}",
          "/submodels/{submodelIdentifier}/submodel-elements",
          "/submodels/{submodelIdentifier}/submodel-elements/{idShortPath}",
        ],
        note: "Identifiers are base64url-encoded. Append /$value for the ValueOnly serialisation.",
      }, 404);
    }

    return problem(404, `Not found: ${path}`, "404");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return problem(500, message || "Internal server error", "500");
  }
}

/**
 * The submodel routes below `/submodels/{id}`, shared by both ways of reaching them. `tail` is
 * whatever followed the identifier: nothing, `submodel-elements`, or
 * `submodel-elements/{idShortPath}`.
 */
function submodelResponse(
  submodel: Record<string, unknown>,
  tail: string[],
  wantsValue: boolean,
): Response {
  if (tail.length === 0) {
    return json(wantsValue ? submodelValueOnly(submodel) : submodel);
  }

  if (tail[0] !== "submodel-elements") {
    return problem(404, `Not found: ${tail.join("/")}`, "404");
  }

  const elements = (submodel.submodelElements as unknown[]) ?? [];

  if (tail.length === 1) {
    return json(paged(
      // deno-lint-ignore no-explicit-any
      wantsValue ? elements.map((e: any) => ({ [e.idShort]: valueOnly(e) })) : elements,
      null,
    ));
  }

  // The remainder is an idShortPath. Rejoined with "." so a client may send the dotted form or a
  // slash-separated path.
  const idShortPath = tail.slice(1).map(decodeURIComponent).join(".");
  const element = elementAt(submodel, idShortPath);
  if (!element) {
    return problem(404, `Submodel has no element at '${idShortPath}'`, "404");
  }

  return json(wantsValue ? valueOnly(element) : element);
}

serve(handler);
