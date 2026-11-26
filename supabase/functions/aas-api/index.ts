/**
 * aas-api: the IDTA-01002 (AAS Part 2) REST surface over live database state, for an ERP, PLM or
 * MES that wants one submodel now and again in ten minutes rather than a whole file. No
 * service-role key: it authenticates the caller and queries as them, so RLS applies. Every relation
 * a shell is read from admits every signed-in caller, so every caller sees the same shells.
 * `aas-export` holds that key, which is why these are two functions with separate environments.
 * The mapping is shared with the exporter (`../_shared/aas/shell.ts`). Identifiers are derived
 * (`${BASE_IRI}${sparkplug_id}/submodel/...`), so an identifier is parsed back to a `sparkplug_id`
 * rather than looked up; changing AAS_BASE_IRI changes every identifier this deployment has
 * published. A schema's submodel ids carry the lineage's name, not the version's, and a submodel is
 * found by its exact id only. The ConceptDescriptions the shells reference are served from each
 * shell's Environment (conceptDescriptions.ts), the Registry's descriptors are projected from the
 * shells (registry.ts), and Discovery matches asset links against them (discovery.ts).
 * Not served: writes (the dashboard is the authoring interface, with its own audit
 * trail), inlined telemetry values (`LinkedSegment` points at the historian) and `.aasx`
 * (aas-export).
 */

import { createClient } from "@supabase/supabase-js";
import type { BuiltShell } from "../_shared/aas/shell.ts";
import { checkCaller } from "../_shared/callerCheck.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";
import { logFailure, REQUEST_ID_HEADER, requestIdOf, SERVER_FAILURE } from "../_shared/failure.ts";
import { conceptDescriptionRoute } from "./conceptDescriptions.ts";
import { discoveryRoute } from "./discovery.ts";
import { ClientMistake, identifierIn, json, paged, pageSize, problem } from "./http.ts";
import { registryRoute } from "./registry.ts";
import { assetOf, devicePage, shellById, shellFor } from "./shells.ts";

const SERVICE_NAME = "aas-api";

// ValueOnly serialisation ($value): IDTA-01002's form that strips the metamodel down to the values,
// so reading a serial number is `body.SerialNumber`.

// deno-lint-ignore no-explicit-any
function valueOnly(element: any): unknown {
  switch (element?.modelType) {
    case "Property":
      // `value` is absent, not null, for an unpublished metric -- see the rule in shell.ts. Null is
      // the honest ValueOnly rendering of that: the element exists and has no value.
      return element.value ?? null;
    case "MultiLanguageProperty":
      // One object for each language, such as { "en": "…" }, as the specification writes one.
      return (element.value ?? []).map((held: { language: string; text: string }) => ({ [held.language]: held.text }));
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

/**
 * The Submodel with exactly this id in a built shell, or null. Both submodel routes read through it,
 * so an id the shell does not carry, a previous version's among them, is a 404 on each.
 */
function submodelIn(built: BuiltShell, identifier: string) {
  return built.submodels.find((s) => s.id === identifier) ?? null;
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
        // SSP-002 is the READ-ONLY service specification profile in each case. Advertising the
        // full SSP-001 would promise the write routes this deliberately does not serve. The
        // ConceptDescription Repository and Discovery have no read-only profile (each one's only
        // profile is SSP-001, with writes), so their GET routes are served and no profile is
        // declared for them.
        "https://admin-shell.io/aas/API/3/0/AssetAdministrationShellRepositoryServiceSpecification/SSP-002",
        "https://admin-shell.io/aas/API/3/0/SubmodelRepositoryServiceSpecification/SSP-002",
        "https://admin-shell.io/aas/API/3/0/AssetAdministrationShellRegistryServiceSpecification/SSP-002",
      ],
    });
  }

  if (req.method !== "GET") {
    // 405 rather than 404: the path may well exist, and a client that gets 404 for a POST will
    // retry the URL rather than stop writing.
    return problem(
      405,
      "This AAS service is read-only; only GET is served. Asset data is written in the dashboard, which keeps its Audit Trail.",
      "405",
    );
  }

  // Everything below is authenticated. Fail closed.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return problem(401, "Missing Authorization header", "401");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = gatewayKey();

  // As the caller. Every read below runs under the caller's RLS policies, which is what keeps this
  // from becoming a way around them.
  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  try {
    // A person's token or a machine identity's; a token the check could not judge is a 500 below.
    const caller = await checkCaller(supabase);
    if (!caller.accepted) {
      if (caller.refused) return problem(401, "Invalid user token", "401");
      throw new Error(`the caller's token could not be checked: ${caller.reason}`);
    }

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

      const identifier = identifierIn(encodedId);
      if (!identifier) {
        return problem(400, "aasIdentifier must be base64url-encoded", "400");
      }

      const built = await shellById(supabase, identifier);
      if (!built) return problem(404, `No shell with identifier '${identifier}'`, "404");

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
        const subIdentifier = identifierIn(tail[1]);
        if (!subIdentifier) {
          return problem(400, "submodelIdentifier must be base64url-encoded", "400");
        }
        const submodel = submodelIn(built, subIdentifier);
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

      const identifier = identifierIn(encodedId);
      if (!identifier) {
        return problem(400, "submodelIdentifier must be base64url-encoded", "400");
      }

      const sparkplugId = assetOf(identifier);
      if (!sparkplugId) return problem(404, `No submodel with identifier '${identifier}'`, "404");

      const built = await shellFor(supabase, sparkplugId);
      const submodel = built ? submodelIn(built, identifier) : null;
      if (!submodel) return problem(404, `No submodel with identifier '${identifier}'`, "404");

      return submodelResponse(submodel, tail, wantsValue);
    }

    // GET /shell-descriptors[/...]: the Registry, a descriptor of each shell /shells serves.
    const registered = await registryRoute(supabase, path, url, limit, cursor);
    if (registered) return registered;

    // GET /lookup/shells[/{aasIdentifier}]: Discovery, from asset links to shell ids and back.
    const discovered = await discoveryRoute(supabase, path, url, limit, cursor);
    if (discovered) return discovered;

    // GET /concept-descriptions[/{cdIdentifier}]: the ConceptDescriptions the shells reference.
    const described = await conceptDescriptionRoute(supabase, path, limit, cursor, devicePage);
    if (described) return described;

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
          "/concept-descriptions",
          "/concept-descriptions/{cdIdentifier}",
          "/shell-descriptors",
          "/shell-descriptors/{aasIdentifier}",
          "/shell-descriptors/{aasIdentifier}/submodel-descriptors",
          "/shell-descriptors/{aasIdentifier}/submodel-descriptors/{submodelIdentifier}",
          "/lookup/shells",
          "/lookup/shells/{aasIdentifier}",
        ],
        note: "Identifiers are base64url-encoded. Append /$value for the ValueOnly serialisation.",
      }, 404);
    }

    return problem(404, `Not found: ${path}`, "404");
  } catch (err) {
    if (err instanceof ClientMistake) return err.answer;
    // The specification's shape, with the request id as the message's correlationId and in the
    // header; the error itself goes to the log under that id.
    const requestId = requestIdOf(req);
    logFailure(SERVICE_NAME, requestId, err);
    const failed = problem(500, SERVER_FAILURE, "500", requestId);
    failed.headers.set(REQUEST_ID_HEADER, requestId);
    failed.headers.set("Access-Control-Expose-Headers", REQUEST_ID_HEADER);
    return failed;
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

Deno.serve(handler);
