/**
 * Where every aas-api route finds its shells: one per device that is not archived, read as the caller
 * and built by `../_shared/aas/shell.ts`. The repository, the Registry and Discovery each page through
 * devicePage() and build through shellFor() or buildShells(), so a shell is the same object on each.
 */

import { BASE_IRI, buildEnvironment, type BuiltShell, loadDeviceRecord, UUID_RE } from "../_shared/aas/shell.ts";
import { ClientMistake } from "./http.ts";

// deno-lint-ignore no-explicit-any
export type Client = any;

/** A device's wire id, as `shell.ts` composes it into every identifier it mints. */
const SPARKPLUG_RE = /^dev[0-9a-f]{21}$/;

/**
 * The `sparkplug_id` an AAS identifier belongs to, or null when it is not one of ours. Accepts the
 * shell form (`<base><id>/shell`) and the submodel form (`<base><id>/submodel/<suffix>`).
 */
export function assetOf(identifier: string): string | null {
  if (!identifier.startsWith(BASE_IRI)) return null;
  const rest = identifier.slice(BASE_IRI.length);
  const first = rest.split("/")[0] ?? "";
  return SPARKPLUG_RE.test(first) ? first : null;
}

/** Which devices a read covers: every one that is not archived, or only those that are not a replay lane. */
export interface DeviceScope {
  lanes?: boolean;
}

/** Build one device's shell, or null when no device in scope carries that wire id. */
export async function shellFor(
  client: Client,
  sparkplugId: string,
  { lanes = true }: DeviceScope = {},
): Promise<BuiltShell | null> {
  let query = client
    .from("devices")
    .select("id")
    .eq("sparkplug_id", sparkplugId)
    .eq("is_archived", false);
  if (!lanes) query = query.is("shadow_of", null);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const id = data?.[0]?.id;
  if (!id) return null;

  const record = await loadDeviceRecord(client, id);
  return record ? buildEnvironment(record) : null;
}

/**
 * The shell whose id is exactly `identifier`, or null. The identifier has to match the shell built,
 * not merely name a device that exists: otherwise `<base><id>/submodel/Nameplate` would resolve as a
 * shell.
 */
export async function shellById(
  client: Client,
  identifier: string,
  scope: DeviceScope = {},
): Promise<BuiltShell | null> {
  const sparkplugId = assetOf(identifier);
  if (!sparkplugId) return null;
  const built = await shellFor(client, sparkplugId, scope);
  return built && built.shell.id === identifier ? built : null;
}

/**
 * A device cursor as the database orders it, lower-case. One that is not a device's id is the
 * client's mistake, a 400, not a query PostgREST refuses.
 */
export function deviceCursor(cursor: string | null): string | null {
  if (cursor === null) return null;
  if (!UUID_RE.test(cursor)) throw new ClientMistake("cursor must be one a previous page returned");
  return cursor.toLowerCase();
}

/**
 * One page of devices, keyset-paginated by `id` rather than `created_at`, so the cursor is stable
 * under insertion. A cursor of /shells, /submodels and /shell-descriptors names the next device, and a
 * page is every item of the devices it covers, which stays stable while the data changes. It decides
 * which shells are published, so the ConceptDescription routes list devices through it too.
 */
export async function devicePage(
  client: Client,
  limit: number,
  rawCursor: string | null,
  { lanes = true }: DeviceScope = {},
) {
  const cursor = deviceCursor(rawCursor);
  let query = client
    .from("devices")
    .select("id, sparkplug_id")
    .eq("is_archived", false);
  if (!lanes) query = query.is("shadow_of", null);
  query = query
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

/**
 * Shells built at once. Each costs about six round trips in sequence, so a page of a hundred built one
 * after another spends most of its time waiting.
 */
const BUILDS_AT_ONCE = 4;

/**
 * The shell of each device id, in the order given, with null where a device has gone since it was
 * listed. At most BUILDS_AT_ONCE are built at a time.
 */
export async function buildShells(client: Client, deviceIds: string[]): Promise<(BuiltShell | null)[]> {
  const built: (BuiltShell | null)[] = new Array(deviceIds.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < deviceIds.length) {
      const at = next++;
      const record = await loadDeviceRecord(client, deviceIds[at]);
      built[at] = record ? buildEnvironment(record) : null;
    }
  };
  await Promise.all(Array.from({ length: Math.min(BUILDS_AT_ONCE, deviceIds.length) }, worker));
  return built;
}
