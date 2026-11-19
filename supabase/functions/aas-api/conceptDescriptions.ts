/**
 * The ConceptDescription Repository's two read routes (IDTA-01002): `GET /concept-descriptions` and
 * `GET /concept-descriptions/{cdIdentifier}`. A ConceptDescription is served when a published shell
 * references its id, and it is the one that shell's Environment carries: buildEnvironment() makes it
 * with buildConceptDescriptions(), from the rows loadDeviceRecord() reads as the caller, as aas-export
 * makes the file's. So the two cannot disagree about a concept, and a definition an imported vocabulary
 * does not share stays out of both.
 */

import { buildEnvironment, loadDeviceRecord } from "../_shared/aas/shell.ts";
import { b64urlDecode, b64urlEncode, json, paged, problem } from "./http.ts";

// deno-lint-ignore no-explicit-any
type Client = any;

export type ConceptDescription = Record<string, unknown> & { id: string };

/** index.ts's devicePage(): one keyset page of the devices whose shells are published. */
export type DevicePage = (
  client: Client,
  limit: number,
  cursor: string | null,
) => Promise<{ page: { id: unknown }[]; nextCursor: string | null }>;

const ROOT = "/concept-descriptions";

/** Devices asked for at a time while collecting: the most one page of /shells holds. */
const DEVICES_PER_READ = 100;

/**
 * Every ConceptDescription the published shells reference, each id once, in id order. Each device's
 * record is read once. Where two shells describe one id differently (two schemas that carry one
 * semantic id with different descriptions), the first device's, in /shells order, is kept. With
 * `only`, it stops at the first shell that references that id.
 */
export async function conceptDescriptionsOfTheShells(
  client: Client,
  devicePage: DevicePage,
  only?: string,
): Promise<ConceptDescription[]> {
  const byId = new Map<string, ConceptDescription>();
  let cursor: string | null = null;
  do {
    const { page, nextCursor } = await devicePage(client, DEVICES_PER_READ, cursor);
    for (const row of page) {
      const record = await loadDeviceRecord(client, String(row.id));
      if (!record) continue;
      const carried = (buildEnvironment(record).environment.conceptDescriptions ?? []) as ConceptDescription[];
      for (const cd of carried) {
        if (only !== undefined && cd.id !== only) continue;
        if (!byId.has(cd.id)) byId.set(cd.id, cd);
      }
      if (only !== undefined && byId.has(only)) return [...byId.values()];
    }
    cursor = nextCursor;
  } while (cursor);
  // By code unit, as the cursor compares, so a page starts exactly after the last id of the one before.
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * One page of `all`, which is in id order: up to `limit` after the id the cursor names. The cursor is
 * the page's last id, base64url-encoded, and is left out on the last page.
 */
export function pageOfConceptDescriptions(
  all: ConceptDescription[],
  limit: number,
  after: string | null,
): { result: ConceptDescription[]; cursor: string | null } {
  const rest = after === null ? all : all.filter((cd) => cd.id > after);
  const result = rest.slice(0, limit);
  return {
    result,
    cursor: rest.length > limit ? b64urlEncode(result[result.length - 1].id) : null,
  };
}

/** A path segment's identifier, or null where it is not percent- or base64url-decodable. */
function identifierIn(segment: string): string | null {
  try {
    return b64urlDecode(decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/**
 * The answer to a ConceptDescription route, or null when `path` is not one. `limit` and `cursor` are
 * the request's, read as every list reads them. The specification's filters (`idShort`, `isCaseOf`,
 * `dataSpecificationRef`) are not read, as /shells reads none of its own, so a filtered request gets
 * every ConceptDescription. No `/$value` form is served: the specification defines none for one.
 */
export async function conceptDescriptionRoute(
  client: Client,
  path: string,
  limit: number,
  cursor: string | null,
  devicePage: DevicePage,
): Promise<Response | null> {
  if (path === ROOT) {
    const after = cursor === null ? null : b64urlDecode(cursor);
    if (cursor !== null && after === null) {
      return problem(400, "cursor must be one a previous page of /concept-descriptions returned", "400");
    }
    const page = pageOfConceptDescriptions(await conceptDescriptionsOfTheShells(client, devicePage), limit, after);
    return json(paged(page.result, page.cursor));
  }

  if (!path.startsWith(`${ROOT}/`)) return null;
  const [encodedId, ...tail] = path.slice(ROOT.length + 1).split("/");
  if (tail.length > 0 || encodedId.startsWith("$")) return problem(404, `Not found: ${path}`, "404");

  const identifier = identifierIn(encodedId);
  if (!identifier) return problem(400, "cdIdentifier must be base64url-encoded", "400");

  // The same answer for an id nobody defines and for one only an unpublished shell references, so
  // a caller cannot tell which ids exist.
  const [found] = await conceptDescriptionsOfTheShells(client, devicePage, identifier);
  return found
    ? json(found)
    : problem(404, `No concept description with identifier '${identifier}'`, "404");
}
