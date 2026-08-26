/**
 * aas-api: the IDTA 02001/02002 REST surface over live database state.
 *
 * WHAT THIS IS FOR. `aas-export` hands somebody a file. That is the right shape for a handover and
 * the wrong shape for an ERP, a PLM or an MES that wants one submodel now and the same submodel
 * again in ten minutes: they would have to fetch, unpack and diff a whole Environment to read a
 * serial number. This serves the same object graph over the routes those systems already speak.
 *
 * ---------------------------------------------------------------------------------------------
 * NO SERVICE-ROLE KEY, AND THAT IS THE DESIGN RATHER THAN AN OMISSION.
 *
 * It authenticates the caller and then queries AS THEM, so RLS decides what they see. Identical
 * reasoning to `fplus-directory`, whose registry entry states it: a live read API over the whole
 * asset space holding the service key would turn every authenticated user's lookup into a
 * privileged one. `aas-export` holds that key and this deliberately does not -- which is also why
 * these are two functions rather than two routes on one. main/index.ts spawns one worker per
 * function with only the environment that function declares, so the separation is enforced by the
 * runtime rather than by care.
 *
 * The mapping is shared with the exporter (`../_shared/aas/shell.ts`) precisely so the two cannot
 * describe the same machine differently.
 *
 * ---------------------------------------------------------------------------------------------
 * HOW AN IDENTIFIER RESOLVES BACK TO A ROW, which is the piece with no equivalent in the exporter.
 *
 * The exporter only ever goes one way: device -> identifiers. A REST API is asked the reverse --
 * "give me the submodel with THIS id" -- and there is no table mapping identifiers to devices,
 * because identifiers are DERIVED (`shell.ts`: `${BASE_IRI}${sparkplug_id}/submodel/...`). So they
 * are parsed rather than looked up: strip the configured base, take the first segment as the
 * `sparkplug_id`, and resolve that against `devices`. Deriving both ways keeps the single source
 * of truth; a mapping table would be a second one that could disagree.
 *
 * A CONSEQUENCE WORTH STATING: changing AAS_BASE_IRI changes every identifier this deployment
 * has ever published, and previously-issued ids stop resolving here. That is already true of the
 * exported files; this endpoint simply makes it observable.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT SERVED.
 *
 *   * WRITES. Every route is a GET. The AAS specification defines POST/PUT/DELETE for a
 *     repository, and implementing them would make this an authoring interface for asset data
 *     whose authoring interface is the dashboard, with its own role model and its own audit trail
 *     in `digital_thread`. A write here would bypass both. The self-description advertises the
 *     read-only service profiles (SSP-002) so a conformant client knows before it tries.
 *   * TELEMETRY VALUES, still. `LinkedSegment` points at the historian exactly as it does in the
 *     export -- see the rule in shell.ts. A live API makes inlining more tempting, not less, and
 *     an unbounded submodel is no better for being fetched over HTTP.
 *   * `.aasx`. That is a packaging format for a handover, and `aas-export` is where it lives.
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

const SERVICE_NAME = "aas-api";
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: jsonHeaders });

/**
 * The specification's error shape, which is not a bare `{error: "..."}`.
 *
 * A conformant client parses `messages[]`, so answering in this stack's usual shape would make
 * every failure unreadable to exactly the tools this endpoint exists for.
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

// ------------------------------------------------------------------------------------------------
// Identifiers
// ------------------------------------------------------------------------------------------------

/**
 * base64url, as IDTA 02002 requires for every Identifier that appears in a path.
 *
 * NOT plain base64: `+` and `/` are not path-safe, and `/` in particular would silently split one
 * identifier across two path segments. Padding is stripped on encode and restored on decode --
 * some clients send it, most do not, and both must work.
 *
 * Encoded through TextEncoder rather than `btoa(str)` directly: `btoa` throws on any code point
 * above U+00FF, and an IRI carrying a non-ASCII character is legal.
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
 * The `sparkplug_id` an AAS identifier belongs to, or null when it is not one of ours.
 *
 * Accepts both the shell form (`<base><id>/shell`) and the submodel form
 * (`<base><id>/submodel/<suffix>`), because both resolve to the same device and the caller of this
 * function always knows which it asked for.
 */
function assetOf(identifier: string): string | null {
  if (!identifier.startsWith(BASE_IRI)) return null;
  const rest = identifier.slice(BASE_IRI.length);
  const first = rest.split("/")[0] ?? "";
  return SPARKPLUG_RE.test(first) ? first : null;
}

// ------------------------------------------------------------------------------------------------
// Pagination
//
// The specification's cursor is OPAQUE to the client, which is what makes the shape below
// conformant even though it does not page one element at a time: a cursor here names the next
// DEVICE, and a page is every item belonging to the devices it covers. Paging per submodel would
// mean either materialising every shell to count them or storing a cursor that encodes a position
// inside a document rebuilt on each request -- and the second is only stable while nothing changes,
// which is the one thing a live API cannot assume.
// ------------------------------------------------------------------------------------------------

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

// ------------------------------------------------------------------------------------------------
// ValueOnly serialisation ($value)
//
// IDTA 02002's ValueOnly form, which is the one an ERP actually wants: it strips the metamodel
// down to the values, so reading a serial number is `body.SerialNumber` rather than a walk through
// `submodelElements[]` looking for a matching idShort.
// ------------------------------------------------------------------------------------------------

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
 * Walk an `idShortPath` -- `Metrics.Systems_TEMPERATURE`, in the specification's dotted form.
 *
 * Only collections are traversable, which is all this mapping produces; a path that runs into a
 * Property mid-way is a 404 rather than a 500, because asking for a child of a leaf is a client
 * mistake and not a server fault.
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

// ------------------------------------------------------------------------------------------------
// Routing
// ------------------------------------------------------------------------------------------------

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
 * One page of devices, keyset-paginated by id.
 *
 * ORDERED BY `id` AND NOT BY `created_at`, because the cursor has to be stable under insertion: two
 * devices registered in the same second would otherwise be able to swap places between pages, and a
 * client walking the cursor would miss one and see the other twice.
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

  // -------------------------------------------------------------------------------------------
  // GET /description -- the service's own profile declaration.
  // -------------------------------------------------------------------------------------------
  // Unauthenticated by specification: a client is expected to read it to find out what it is
  // talking to BEFORE it holds a credential, which is the same argument that keeps
  // fplus-directory's /ping open. It reports profiles and nothing about the fleet.
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

  // -------------------------------------------------------------------------------------------
  // Everything below is authenticated. FAIL CLOSED.
  // -------------------------------------------------------------------------------------------
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return problem(401, "Missing Authorization header", "401");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

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

    // -----------------------------------------------------------------------------------------
    // GET /shells -- every shell this deployment publishes.
    // -----------------------------------------------------------------------------------------
    if (bare === "/shells") {
      const { page, nextCursor } = await devicePage(supabase, limit, cursor);
      const shells = [];
      for (const row of page) {
        const built = await shellFor(supabase, String(row.sparkplug_id));
        if (built) shells.push(built.shell);
      }
      return json(paged(shells, nextCursor));
    }

    // -----------------------------------------------------------------------------------------
    // GET /submodels -- every submodel, across every shell.
    // -----------------------------------------------------------------------------------------
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

    // -----------------------------------------------------------------------------------------
    // /shells/{aasIdentifier}...
    // -----------------------------------------------------------------------------------------
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

      // GET /shells/{aasId}/submodels/{submodelId}[/...] -- the same submodel routes, reached
      // through the shell. Delegated rather than duplicated: the only difference is that the
      // submodel must belong to THIS shell, which is checked here and then handed on.
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

    // -----------------------------------------------------------------------------------------
    // /submodels/{submodelIdentifier}...
    // -----------------------------------------------------------------------------------------
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

    // -----------------------------------------------------------------------------------------
    // GET / -- what this service serves.
    // -----------------------------------------------------------------------------------------
    // The specification defines no route index, and this is not pretending to be one: it answers
    // 404, because there is no resource at the root. It names the routes in the body for the same
    // reason fplus-directory does -- somebody who has just found this URL in a config file needs
    // to know what to ask for next, and the alternative is reading the OpenAPI document to learn
    // that a path exists at all.
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
 * The submodel routes below `/submodels/{id}`, shared by both ways of reaching them.
 *
 * `tail` is whatever followed the identifier: nothing, `submodel-elements`, or
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

  // The remainder is an idShortPath. Rejoined with "/" first because a client may send either the
  // dotted form the specification defines or a slash-separated path; both are accepted, and the
  // walk below splits on "." after normalising.
  const idShortPath = tail.slice(1).map(decodeURIComponent).join(".");
  const element = elementAt(submodel, idShortPath);
  if (!element) {
    return problem(404, `Submodel has no element at '${idShortPath}'`, "404");
  }

  return json(wantsValue ? valueOnly(element) : element);
}

serve(handler);
