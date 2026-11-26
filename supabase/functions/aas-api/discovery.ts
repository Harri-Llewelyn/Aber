/**
 * The Discovery service's read routes (IDTA-01002): `GET /lookup/shells?assetIds=...` answers the ids of
 * the shells whose asset links hold every link asked for, and `GET /lookup/shells/{aasIdentifier}` one
 * shell's links. A shell's links are its globalAssetId, under the name `globalAssetId`, and its
 * specificAssetIds, exactly as `/shells` serves them: each answer is matched against a shell built by
 * buildEnvironment(), so Discovery cannot name a link the shell does not carry. A replay lane is not
 * indexed: it is a recording of an asset, not a second asset, and its birth repeats the original's
 * serial number.
 *
 * The index is read rather than kept. Each link narrows the candidates with a query of the rows the
 * shell takes it from, and each candidate is then built and matched. The candidates are devices; a kind
 * of shell that is not a device adds its own candidates in devicesThatMayCarry().
 */

import {
  BASE_IRI,
  type BuiltShell,
  OPC_MACHINERY,
  SPECIFIC_ASSET_ID_NAMES,
  type SpecificAssetId,
} from "../_shared/aas/shell.ts";
import { b64urlDecode, ClientMistake, identifierIn, json, paged, problem } from "./http.ts";
import { buildShells, type Client, deviceCursor, devicePage, shellById } from "./shells.ts";

const ROOT = "/lookup/shells";

/** The name a shell's globalAssetId is looked up by (the metamodel's constraint AASd-116). */
export const GLOBAL_ASSET_ID = "globalAssetId";

/** One asset link: a name and a value, compared exactly. */
export interface AssetLink {
  name: string;
  value: string;
}

/** The literal metric names a nameplate value falls back to, as buildEnvironment() reads them. */
const FALLBACK_METRICS: Record<string, string[]> = {
  [SPECIFIC_ASSET_ID_NAMES.serialNumber]: ["SERIAL_NUMBER"],
  [SPECIFIC_ASSET_ID_NAMES.productUri]: [],
};

/** Where an operator records each nameplate value a link is taken from. */
const NAMEPLATE_COLUMNS: Record<string, string> = {
  [SPECIFIC_ASSET_ID_NAMES.serialNumber]: "serial_number",
  [SPECIFIC_ASSET_ID_NAMES.productUri]: "uri_of_the_product",
};

/** The concept a device publishes each nameplate value under. */
const PUBLISHED_AS: Record<string, string> = {
  [SPECIFIC_ASSET_ID_NAMES.serialNumber]: OPC_MACHINERY.SerialNumber,
  [SPECIFIC_ASSET_ID_NAMES.productUri]: OPC_MACHINERY.ProductInstanceUri,
};

/** Ids in one `in.()` filter, so a value many devices share never makes a URL too long for the gateway. */
const IDS_PER_READ = 100;

/** Candidates built at a time while a lookup looks for a page of matches. */
const CANDIDATES_PER_ROUND = 20;

// deno-lint-ignore no-explicit-any
type Anything = any;

/** A shell's asset links: its globalAssetId first, then its specificAssetIds, as the shell carries them. */
export function assetLinksOf(built: BuiltShell): SpecificAssetId[] {
  const asset = ((built.shell as Anything).assetInformation ?? {}) as Record<string, unknown>;
  const global = asset.globalAssetId ? [{ name: GLOBAL_ASSET_ID, value: String(asset.globalAssetId) }] : [];
  return [...global, ...((asset.specificAssetIds as SpecificAssetId[] | undefined) ?? [])];
}

/** Whether a shell carries every one of `links`, each by its exact name and value. */
export function carriesEvery(built: BuiltShell, links: AssetLink[]): boolean {
  const held = assetLinksOf(built);
  return links.every((link) => held.some((h) => h.name === link.name && h.value === link.value));
}

/**
 * The links a request asks for. Each `assetIds` value is a base64url-encoded SpecificAssetId, as the
 * specification writes one; an encoded array of them is read too. Only `name` and `value` are compared.
 */
export function linksAskedFor(url: URL): AssetLink[] {
  const links: AssetLink[] = [];
  for (const encoded of url.searchParams.getAll("assetIds")) {
    const decoded = b64urlDecode(encoded);
    let parsed: unknown;
    try {
      parsed = decoded === null ? undefined : JSON.parse(decoded);
    } catch {
      parsed = undefined;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      const { name, value } = (item ?? {}) as Record<string, unknown>;
      if (typeof name !== "string" || typeof value !== "string" || !name || !value) {
        throw new ClientMistake(
          'assetIds must each be a base64url-encoded SpecificAssetId, such as {"name":"partInstanceId","value":"SN-0001"}',
        );
      }
      links.push({ name, value });
    }
  }
  return links;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function rows(query: Anything): Promise<Record<string, unknown>[]> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** The ids of the devices Discovery indexes, of those whose `column` is one of `values`: not archived, not a lane. */
async function indexedDevices(client: Client, column: string, values: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const chunk of chunks([...new Set(values)], IDS_PER_READ)) {
    const found = await rows(
      client.from("devices").select("id").in(column, chunk).eq("is_archived", false).is("shadow_of", null),
    );
    ids.push(...found.map((row) => String(row.id)));
  }
  return ids;
}

/**
 * The catalog metrics a device may publish a concept under: those that carry its id as their own or as
 * a further one, and the literal fallbacks. More than buildEnvironment() reads, which takes the first.
 */
async function metricsPublishing(client: Client, semanticId: string, fallbacks: string[]): Promise<string[]> {
  const [own, further]: Record<string, unknown>[][] = await Promise.all([
    rows(client.from("metric_catalog").select("name").eq("semantic_id", semanticId)),
    // Without rows (an error, or a database that lacks the table) no metric carries a further id, as
    // loadDeviceRecord() reads it.
    client.from("metric_semantic_ids").select("metric_id").eq("semantic_id", semanticId)
      .then(({ data }: Anything) => data ?? []),
  ]);
  const furtherIds = further.map((row) => String(row.metric_id));
  const named = furtherIds.length > 0
    ? (await Promise.all(chunks(furtherIds, IDS_PER_READ).map((chunk) =>
      rows(client.from("metric_catalog").select("name").in("id", chunk))
    ))).flat()
    : [];
  return [...new Set([...own, ...named].map((row) => String(row.name)).concat(fallbacks))];
}

/**
 * The wire ids of the devices that published `value` under one of `metrics` at their birth, in any of
 * the columns ingestion writes. A number or a boolean is matched as buildEnvironment() prints it.
 */
async function devicesPublishing(client: Client, metrics: string[], value: string): Promise<string[]> {
  if (metrics.length === 0) return [];
  const asText = (column: string, wanted: unknown) =>
    rows(client.from("asset_config").select("asset_id").in("metric_name", metrics).eq(column, wanted));
  const reads = [asText("val_string", value)];
  const number = Number(value);
  if (value.trim() !== "" && Number.isFinite(number)) reads.push(asText("val_double", number));
  if (value === "true" || value === "false") reads.push(asText("val_bool", value === "true"));
  return (await Promise.all(reads)).flat().map((row) => String(row.asset_id));
}

/**
 * The indexed devices whose shell may carry `link`: more than do, never fewer. Each is built and
 * matched after. A name no shell carries has none.
 */
async function devicesThatMayCarry(client: Client, link: AssetLink): Promise<string[]> {
  const { name, value } = link;
  if (name === GLOBAL_ASSET_ID) {
    return value.startsWith(BASE_IRI) ? indexedDevices(client, "sparkplug_id", [value.slice(BASE_IRI.length)]) : [];
  }
  if (name === SPECIFIC_ASSET_ID_NAMES.sparkplugId) return indexedDevices(client, "sparkplug_id", [value]);

  const column = NAMEPLATE_COLUMNS[name];
  if (!column) return [];
  const [recorded, published] = await Promise.all([
    rows(client.from("device_nameplate").select("device_id").eq(column, value)),
    metricsPublishing(client, PUBLISHED_AS[name], FALLBACK_METRICS[name]).then((metrics) =>
      devicesPublishing(client, metrics, value)
    ),
  ]);
  const [byId, byWireId] = await Promise.all([
    indexedDevices(client, "id", recorded.map((row) => String(row.device_id))),
    indexedDevices(client, "sparkplug_id", published),
  ]);
  return [...new Set([...byId, ...byWireId])];
}

/**
 * One page of the ids of the shells that carry every one of `links`, in device order, and the cursor
 * of the next. With no links it is every indexed shell. The cursor names the last device of the page.
 */
export async function shellIdsByAssetLinks(
  client: Client,
  links: AssetLink[],
  limit: number,
  rawCursor: string | null,
): Promise<{ ids: string[]; nextCursor: string | null }> {
  if (links.length === 0) {
    const { page, nextCursor } = await devicePage(client, limit, rawCursor, { lanes: false });
    const built = await buildShells(client, page.map((row: { id: unknown }) => String(row.id)));
    return { ids: built.filter((shell) => shell !== null).map((shell) => String(shell!.shell.id)), nextCursor };
  }
  const cursor = deviceCursor(rawCursor);

  // Every link must hold, so the candidates are those every link names.
  let candidates: string[] | null = null;
  for (const link of links) {
    const may = new Set(await devicesThatMayCarry(client, link));
    candidates = candidates === null ? [...may] : candidates.filter((id) => may.has(id));
    if (candidates.length === 0) return { ids: [], nextCursor: null };
  }
  const ordered = candidates!.filter((id) => cursor === null || id > cursor).sort();

  // One match past the page says whether there is another page.
  const matched: { deviceId: string; shellId: string }[] = [];
  for (const round of chunks(ordered, CANDIDATES_PER_ROUND)) {
    const built = await buildShells(client, round);
    built.forEach((shell, at) => {
      if (shell && carriesEvery(shell, links)) matched.push({ deviceId: round[at], shellId: String(shell.shell.id) });
    });
    if (matched.length > limit) break;
  }
  const page = matched.slice(0, limit);
  return {
    ids: page.map((match) => match.shellId),
    nextCursor: matched.length > limit ? page[page.length - 1].deviceId : null,
  };
}

/**
 * The answer to a Discovery route, or null when `path` is not one. `limit` and `cursor` are the
 * request's. The writes, which add and remove a shell's links, are refused before this, as every
 * write is: a shell's links are what its device and its nameplate say.
 */
export async function discoveryRoute(
  client: Client,
  path: string,
  url: URL,
  limit: number,
  cursor: string | null,
): Promise<Response | null> {
  if (path === ROOT) {
    const { ids, nextCursor } = await shellIdsByAssetLinks(client, linksAskedFor(url), limit, cursor);
    return json(paged(ids, nextCursor));
  }

  if (!path.startsWith(`${ROOT}/`)) return null;
  const [encodedId, ...tail] = path.slice(ROOT.length + 1).split("/");
  if (tail.length > 0) return problem(404, `Not found: ${path}`, "404");
  const identifier = identifierIn(encodedId);
  if (!identifier) return problem(400, "aasIdentifier must be base64url-encoded", "400");

  // The same answer for a lane, an archived device and an id nobody holds: none is indexed.
  const built = await shellById(client, identifier, { lanes: false });
  return built
    ? json(assetLinksOf(built))
    : problem(404, `No shell with identifier '${identifier}' is indexed by Discovery`, "404");
}
