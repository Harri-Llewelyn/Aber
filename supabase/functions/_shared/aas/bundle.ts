/**
 * The per-asset bundle: what `aas-export` adds to an AASX when a device is taken away before it is
 * taken out of service. The package stays an AASX -- the same Environment, the same OPC chain --
 * and gains supplementary parts under aasx/files/acs-cymru/: the device's digital thread, the
 * telemetry still in the live historian at two resolutions, and a manifest that says what each
 * part holds, where it was cut off, and which cold-tier objects hold what the live historian no
 * longer does. A reader that knows nothing of the parts ignores them.
 *
 * WHAT THE BUNDLE STATES RATHER THAN REACHES FOR. Cold telemetry keeps its no-read-back rule: the
 * manifest names the objects whose range overlaps the device's life and does not fetch them. Both
 * telemetry parts are capped, newest first, and a cap that was hit is a line in the manifest, not
 * a silent tail. The hourly rollup is included because it reaches years further back than raw
 * (0111); the minute rollups are not, and the manifest says so.
 *
 * PURE FUNCTIONS FIRST, I/O AFTER. `csvOf`, `describeCoverage`, `exportObjectKey` and
 * `buildBundleManifest` take rows and return text or objects, so the suite can execute them in
 * Node from this file's own source; the loaders take a Supabase client.
 */

export const BUNDLE_SCHEMA = "acs-cymru/asset-bundle/1";

/** Where the parts sit inside the package. `aasx/files/` is where AASX readers expect supplements. */
export const BUNDLE_PART_DIR = "aasx/files/acs-cymru";
export const BUNDLE_PARTS = {
  manifest: `${BUNDLE_PART_DIR}/manifest.json`,
  thread: `${BUNDLE_PART_DIR}/digital-thread.json`,
  raw: `${BUNDLE_PART_DIR}/telemetry-raw.csv`,
  hourly: `${BUNDLE_PART_DIR}/telemetry-1h.csv`,
} as const;

/**
 * The caps, each overridable through the environment the function registry forwards. Raw and
 * hourly share the telemetry cap: an hourly part is one row per metric per hour, so the cap is
 * reached only by a device with years of history, which is the device an export is taken for.
 */
export const DEFAULT_MAX_TELEMETRY_ROWS = 200_000;
export const DEFAULT_MAX_THREAD_ROWS = 20_000;
/** One PostgREST page. Keyset-paged on time, so the remote scan stops after this many rows. */
export const TELEMETRY_PAGE_SIZE = 5_000;

/**
 * Where a stored bundle goes.
 *
 * FIXED, NOT CONFIGURABLE. `supabase/storage-policies.sql` and `scripts/storage-init.mjs` name
 * this bucket too, and a name that can be changed in one place is a bucket with no policies.
 * It used to be read from the `archive.bucket` setting, which is retired with the local cold
 * tier (migration 0132) -- a stored bundle is a copy somebody asked for, not the only remaining
 * copy of anything, so it stays on local storage where a signed URL reaches it.
 */
export const EXPORT_BUCKET = "asset-exports";
export const EXPORT_PREFIX = "assets";
export const EXPORT_CONTENT_TYPE = "application/octet-stream";

/** The columns each CSV part carries, in this order; `asset_id` is the manifest's, not a column. */
export const RAW_COLUMNS = ["time", "metric_name", "val_double", "val_string", "val_bool"];
export const HOURLY_COLUMNS = [
  "bucket", "metric_name", "avg_double", "min_double", "max_double",
  "last_double", "last_string", "last_bool", "n_double", "n_rows",
];

/** A positive integer from the environment, or the fallback. Zero and garbage are the fallback. */
export function boundedInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * RFC 4180: a field holding a comma, a quote or a line break is quoted, and a quote inside it is
 * doubled. `null` and `undefined` are the empty field, so a reader tells absent from "". Booleans
 * and numbers print as JSON does.
 */
export function csvOf(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = typeof value === "string" ? value : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/**
 * What one telemetry part covers, as a reader needs it stated: the rows it holds, whether the cap
 * cut it, the span those rows cover, and how far back the relation itself reaches. `horizon` is
 * the relation's oldest row on the whole historian (telemetry_horizons), so "oldest included is
 * later than the horizon" is exactly the sentence "the cap cut this device's history".
 */
export function describeCoverage(
  rowCount: number,
  cap: number,
  oldest: string | null,
  newest: string | null,
  horizon: string | null | undefined,
): Record<string, unknown> {
  const truncated = rowCount >= cap;
  return {
    rows: rowCount,
    cap,
    truncated,
    oldest_included: oldest,
    newest_included: newest,
    // undefined means the lookup did not answer; null means the relation is empty.
    relation_reaches_back_to: horizon === undefined ? "unknown" : horizon,
    note: truncated
      ? `Cut at ${cap} rows, newest first: readings older than ${oldest ?? "the oldest included"} are not in this part.`
      : "Every row the live historian held for this device at this resolution.",
  };
}

/** `assets/<sparkplug_id>/<stamp>.aasx`, the stamp filename-safe and sortable. */
export function exportObjectKey(sparkplugId: string, takenAt: string): string {
  const stamp = takenAt.replace(/[:.]/g, "-");
  return `${EXPORT_PREFIX}/${sparkplugId}/${stamp}.aasx`;
}

/** Any Supabase client. Structural, as shell.ts declares it: the authority is the caller's. */
// deno-lint-ignore no-explicit-any
type Client = any;

export interface TelemetryPart {
  rows: Record<string, unknown>[];
  truncated: boolean;
  oldest: string | null;
  newest: string | null;
  /** Set when paging stopped for a reason other than the cap or the end of the data. */
  stopped?: string;
}

/**
 * Every row of one telemetry relation for one asset, newest first, up to the cap.
 *
 * KEYSET, NOT OFFSET. `postgres_fdw` pushes WHERE and ORDER BY to the historian but not LIMIT, so
 * an offset page re-reads the whole range remotely and discards it locally. A `time <= cursor`
 * page lets the local scan stop after one page of the remote cursor. The boundary instant is
 * re-read on the next page and its already-emitted metrics dropped, so a timestamp shared by
 * several metrics loses nothing. A page that adds no new row means one instant holds more rows
 * than a page, which no device produces; it stops the loop rather than spinning it.
 */
export async function loadTelemetry(
  client: Client,
  relation: "telemetry" | "telemetry_1h",
  sparkplugId: string,
  cap: number,
  pageSize = TELEMETRY_PAGE_SIZE,
): Promise<TelemetryPart> {
  const timeColumn = relation === "telemetry" ? "time" : "bucket";
  const columns = relation === "telemetry" ? RAW_COLUMNS : HOURLY_COLUMNS;
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  let seenAtCursor = new Set<string>();

  while (rows.length < cap) {
    const want = Math.min(pageSize, cap - rows.length);
    let query = client
      .from(relation)
      .select(columns.join(","))
      .eq("asset_id", sparkplugId)
      .order(timeColumn, { ascending: false })
      .order("metric_name", { ascending: true })
      .limit(want + seenAtCursor.size);
    if (cursor) query = query.lte(timeColumn, cursor);

    const { data, error } = await query;
    if (error) throw new Error(`${relation}: ${error.message}`);
    const page = (data ?? []) as Record<string, unknown>[];

    const fresh = page.filter((r) =>
      !(String(r[timeColumn]) === cursor && seenAtCursor.has(String(r.metric_name)))
    );
    if (fresh.length === 0) {
      if (page.length > 0) {
        return {
          rows, truncated: true, oldest: rows.at(-1)?.[timeColumn] as string ?? null,
          newest: rows[0]?.[timeColumn] as string ?? null,
          stopped: `one instant at ${cursor} holds more rows than a page`,
        };
      }
      break;
    }

    for (const r of fresh) {
      if (rows.length >= cap) break;
      rows.push(r);
    }
    if (page.length < want + seenAtCursor.size) break;

    const last = rows.at(-1)!;
    const lastTime = String(last[timeColumn]);
    if (lastTime !== cursor) seenAtCursor = new Set<string>();
    cursor = lastTime;
    for (const r of rows) {
      if (String(r[timeColumn]) === cursor) seenAtCursor.add(String(r.metric_name));
    }
  }

  return {
    rows,
    truncated: rows.length >= cap,
    oldest: rows.length ? String(rows[rows.length - 1][timeColumn]) : null,
    newest: rows.length ? String(rows[0][timeColumn]) : null,
  };
}

/**
 * The device's own thread: every row keyed by its id, which is the devices rows and the nameplate
 * rows (device_nameplate is keyed by device id). Oldest first, so the part reads as a history.
 */
export async function loadThread(
  client: Client,
  deviceId: string,
  cap: number,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const { data, error } = await client
    .from("digital_thread")
    .select("id,entity_type,entity_id,action,old_data,new_data,changed_by,actor_source,causation_id,recorded_at,audit_domain")
    .eq("entity_id", deviceId)
    .order("id", { ascending: true })
    .limit(cap + 1);
  if (error) throw new Error(`digital_thread: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  return { rows: rows.slice(0, cap), truncated: rows.length > cap };
}

/** relation -> oldest row on the historian, or undefined for a relation the view did not name. */
export async function loadHorizons(client: Client): Promise<Record<string, string | null>> {
  const { data, error } = await client.from("telemetry_horizons").select("relation,oldest");
  if (error) throw new Error(`telemetry_horizons: ${error.message}`);
  const out: Record<string, string | null> = {};
  for (const r of (data ?? []) as { relation: string; oldest: string | null }[]) {
    out[r.relation] = r.oldest;
  }
  return out;
}

export interface ColdObjects {
  objects: Record<string, unknown>[];
  /** Why the list is empty when it is not because nothing overlaps. */
  unavailable?: string;
}

/**
 * The cold-tier objects whose range overlaps [from, to]. Read AS THE CALLER through
 * cold_storage_rows(), which gates on the three roles the bucket admits: an Operator taking an
 * export is refused the catalogue, and the manifest says so rather than listing nothing as if
 * nothing overlapped. The objects are named, never fetched.
 */
export async function loadColdObjects(
  userClient: Client,
  from: string | null,
  to: string,
): Promise<ColdObjects> {
  const { data, error } = await userClient.rpc("cold_storage_rows");
  if (error) return { objects: [], unavailable: `the cold catalogue could not be read: ${error.message}` };
  const rows = (data ?? []) as Record<string, unknown>[];
  const lower = from ? Date.parse(from) : Number.NEGATIVE_INFINITY;
  const upper = Date.parse(to);
  const objects = rows
    .filter((r) => r.object_key)
    .filter((r) => Date.parse(String(r.range_end)) >= lower && Date.parse(String(r.range_start)) <= upper)
    .map((r) => ({
      object_key: r.object_key,
      range_start: r.range_start,
      range_end: r.range_end,
      state: r.state,
      on_cold_storage: r.on_cold_storage,
      row_count: r.row_count,
    }));
  return { objects };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ManifestInput {
  takenAt: string;
  takenBy: { id: string; email: string | null };
  device: Record<string, unknown>;
  gateway: Record<string, unknown> | null;
  caps: { telemetry: number; thread: number };
  raw: TelemetryPart;
  hourly: TelemetryPart;
  thread: { rows: Record<string, unknown>[]; truncated: boolean };
  horizons: Record<string, string | null>;
  cold: ColdObjects;
  bundled3dModel: boolean;
}

/**
 * The manifest part. Pure: everything it says is derived from what the loaders returned, so the
 * same inputs give the same document and the suite can hold it to a fixture.
 */
export function buildBundleManifest(input: ManifestInput): Record<string, unknown> {
  const { device, gateway, raw, hourly, thread, horizons, cold, caps } = input;
  const notIncluded: string[] = [];

  if (raw.truncated) notIncluded.push(`raw telemetry older than ${raw.oldest ?? "the oldest included row"} (cap of ${caps.telemetry} rows)`);
  if (raw.stopped) notIncluded.push(`raw telemetry: paging stopped because ${raw.stopped}`);
  if (hourly.truncated) notIncluded.push(`hourly telemetry older than ${hourly.oldest ?? "the oldest included row"} (cap of ${caps.telemetry} rows)`);
  if (hourly.stopped) notIncluded.push(`hourly telemetry: paging stopped because ${hourly.stopped}`);
  if (thread.truncated) notIncluded.push(`digital thread rows after the first ${caps.thread}`);
  notIncluded.push("the 1-minute and 5-minute rollups: the hourly one reaches furthest back and is the one included");
  notIncluded.push("cold telemetry objects: named below, never read back (the no-read-back rule of the cold tier)");
  if (cold.unavailable) notIncluded.push(`the cold catalogue: ${cold.unavailable}`);
  if (device.model_3d_path && !input.bundled3dModel) notIncluded.push("the 3D model: not bundled, the shell carries a URL reference");

  return {
    schema: BUNDLE_SCHEMA,
    taken_at: input.takenAt,
    taken_by: input.takenBy,
    device: {
      id: device.id,
      name: device.name,
      sparkplug_id: device.sparkplug_id,
      created_at: device.created_at ?? null,
      is_archived: device.is_archived ?? false,
      archived_at: device.archived_at ?? null,
      gateway: gateway ? { name: gateway.name, sparkplug_id: gateway.sparkplug_id } : null,
    },
    parts: {
      environment: "aasx/aasenv-root.json",
      digital_thread: BUNDLE_PARTS.thread,
      telemetry_raw: BUNDLE_PARTS.raw,
      telemetry_1h: BUNDLE_PARTS.hourly,
    },
    digital_thread: { rows: thread.rows.length, cap: caps.thread, truncated: thread.truncated },
    telemetry: {
      // The historian keys every reading by this and nothing else; a reader joining the parts to
      // the cold objects needs it stated once.
      asset_id: device.sparkplug_id,
      raw: describeCoverage(raw.rows.length, caps.telemetry, raw.oldest, raw.newest, horizons.telemetry),
      hourly: describeCoverage(hourly.rows.length, caps.telemetry, hourly.oldest, hourly.newest, horizons.telemetry_1h),
    },
    cold_objects: cold.objects,
    not_included: notIncluded,
  };
}
