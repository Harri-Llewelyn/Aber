/**
 * The Asset Administration Shell Registry's read routes (IDTA-01002, its read profile SSP-002):
 * `GET /shell-descriptors`, `/shell-descriptors/{aasIdentifier}`, and the submodel descriptors below
 * one. A descriptor is a projection of the shell `/shells` serves, built by the same buildEnvironment()
 * from the rows the caller reads, so the Registry and the repository cannot disagree about a shell.
 * Each endpoint is this service's own route for that shell or submodel. The list pages as `/shells`
 * does: a cursor names the next device.
 */

import type { BuiltShell } from "../_shared/aas/shell.ts";
import { b64urlDecode, b64urlEncode, identifierIn, json, paged, problem } from "./http.ts";
import { buildShells, type Client, devicePage, shellById } from "./shells.ts";

/**
 * This service's address as a client outside the cluster reaches it: every endpoint a descriptor
 * names starts with it. SUPABASE_PUBLIC_URL is the gateway's public address, which the chart derives
 * from the site's domain; SUPABASE_URL names an in-cluster Service that nothing outside resolves.
 */
export const SERVICE_URL = `${
  (Deno.env.get("SUPABASE_PUBLIC_URL") ?? "http://localhost:54321").replace(/\/+$/, "")
}/functions/v1/aas-api`;

const ROOT = "/shell-descriptors";

/** IDTA-01002's interface names, with the API version this service implements. */
const SHELL_INTERFACE = "AAS-3.0";
const SUBMODEL_INTERFACE = "SUBMODEL-3.0";

/** The metamodel's AssetKind values: what `assetKind` may ask for. */
const ASSET_KINDS = ["Instance", "NotApplicable", "Type"];

// deno-lint-ignore no-explicit-any
type Anything = any;

/** The fields of `source` that are set, of those named: a descriptor leaves out what its shell leaves out. */
function present(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined && source[key] !== null).map((key) => [key, source[key]]));
}

function endpoint(interfaceName: string, href: string, serviceUrl: string) {
  return {
    interface: interfaceName,
    protocolInformation: {
      href,
      endpointProtocol: new URL(serviceUrl).protocol.replace(/:$/, "").toUpperCase(),
      endpointProtocolVersion: ["1.1"],
    },
  };
}

/** A submodel's descriptor: its identity and semantics as the submodel states them, and where to read it. */
export function submodelDescriptor(submodel: Record<string, unknown>, serviceUrl = SERVICE_URL) {
  return {
    ...present(submodel, ["description", "displayName", "extensions", "administration", "idShort", "id", "semanticId"]),
    // The metamodel's plural is the descriptor's singular.
    ...(submodel.supplementalSemanticIds ? { supplementalSemanticId: submodel.supplementalSemanticIds } : {}),
    endpoints: [endpoint(SUBMODEL_INTERFACE, `${serviceUrl}/submodels/${b64urlEncode(String(submodel.id))}`, serviceUrl)],
  };
}

/** A shell's descriptor, with every submodel it references described inside it. */
export function shellDescriptor(built: BuiltShell, serviceUrl = SERVICE_URL) {
  const shell = built.shell as Anything;
  const asset = (shell.assetInformation ?? {}) as Record<string, unknown>;
  return {
    ...present(shell, ["description", "displayName", "extensions", "administration"]),
    ...present(asset, ["assetKind", "assetType"]),
    endpoints: [endpoint(SHELL_INTERFACE, `${serviceUrl}/shells/${b64urlEncode(String(shell.id))}`, serviceUrl)],
    ...present(asset, ["globalAssetId"]),
    ...present(shell, ["idShort", "id"]),
    ...present(asset, ["specificAssetIds"]),
    submodelDescriptors: built.submodels.map((submodel) => submodelDescriptor(submodel, serviceUrl)),
  };
}

type Descriptor = ReturnType<typeof shellDescriptor>;

/**
 * Which descriptors a listing keeps: `assetKind` and `assetType` as the specification defines them, the
 * second base64url-encoded. A filtered page may hold fewer than `limit`, or none, and still carry a
 * cursor, since a page is a page of devices.
 */
function listingFilter(url: URL): ((descriptor: Descriptor) => boolean) | Response {
  const kind = url.searchParams.get("assetKind");
  if (kind !== null && !ASSET_KINDS.includes(kind)) {
    return problem(400, `assetKind must be one of ${ASSET_KINDS.join(", ")}`, "400");
  }
  const encodedType = url.searchParams.get("assetType");
  const type = encodedType === null ? null : b64urlDecode(encodedType);
  if (encodedType !== null && !type) return problem(400, "assetType must be base64url-encoded", "400");
  return (descriptor: Anything) =>
    (kind === null || descriptor.assetKind === kind) && (type === null || descriptor.assetType === type);
}

/**
 * One page of a shell's submodel descriptors, in the order the shell references its submodels. The
 * cursor is the page's last id, base64url-encoded, and is left out on the last page.
 */
function submodelDescriptorPage(all: Anything[], limit: number, cursor: string | null): Response {
  let start = 0;
  if (cursor !== null) {
    const after = b64urlDecode(cursor);
    const at = after === null ? -1 : all.findIndex((descriptor) => descriptor.id === after);
    if (at < 0) return problem(400, "cursor must be one a previous page of submodel descriptors returned", "400");
    start = at + 1;
  }
  const result = all.slice(start, start + limit);
  const more = start + limit < all.length;
  return json(paged(result, more ? b64urlEncode(result[result.length - 1].id) : null));
}

/**
 * The answer to a Registry route, or null when `path` is not one. `limit` and `cursor` are the
 * request's, read as every list reads them. No `/$value` or other modifier is served: the
 * specification defines none for a descriptor.
 */
export async function registryRoute(
  client: Client,
  path: string,
  url: URL,
  limit: number,
  cursor: string | null,
  serviceUrl = SERVICE_URL,
): Promise<Response | null> {
  if (path === ROOT) {
    const admits = listingFilter(url);
    if (admits instanceof Response) return admits;
    const { page, nextCursor } = await devicePage(client, limit, cursor);
    const built = await buildShells(client, page.map((row: { id: unknown }) => String(row.id)));
    const result = built
      .filter((shell): shell is BuiltShell => shell !== null)
      .map((shell) => shellDescriptor(shell, serviceUrl))
      .filter(admits);
    return json(paged(result, nextCursor));
  }

  if (!path.startsWith(`${ROOT}/`)) return null;
  const [encodedId, ...tail] = path.slice(ROOT.length + 1).split("/");
  const identifier = identifierIn(encodedId);
  if (!identifier) return problem(400, "aasIdentifier must be base64url-encoded", "400");

  const built = await shellById(client, identifier);
  if (!built) return problem(404, `No shell descriptor with identifier '${identifier}'`, "404");
  const descriptor = shellDescriptor(built, serviceUrl);

  if (tail.length === 0) return json(descriptor);
  if (tail[0] !== "submodel-descriptors" || tail.length > 2) return problem(404, `Not found: ${path}`, "404");
  if (tail.length === 1) return submodelDescriptorPage(descriptor.submodelDescriptors, limit, cursor);

  const submodelId = identifierIn(tail[1]);
  if (!submodelId) return problem(400, "submodelIdentifier must be base64url-encoded", "400");
  const found = descriptor.submodelDescriptors.find((submodel: Anything) => submodel.id === submodelId);
  return found
    ? json(found)
    : problem(404, `Shell '${identifier}' has no submodel descriptor '${submodelId}'`, "404");
}
