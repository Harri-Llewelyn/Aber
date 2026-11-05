/**
 * A service's recent log lines, for the System page's Logs tab. Administrator only: the lines carry
 * failed sign-ins, addresses and emails, and the store behind them has no access control of its
 * own, so this function is the one way a browser reads it.
 *
 *   GET [?range=]                        the services that wrote a line in the last 7 days
 *   GET ?from=&to=                       the services that wrote a line between the two instants
 *   GET ?service=&level=&filter=&range=&limit=
 *                                        that service's newest lines in the range back from now,
 *                                        newest first
 *   GET ?service=&level=&filter=&from=&to=&limit=
 *                                        the same, between two instants
 *
 * Parameters, never a query: store.ts builds the one query shape from them. Over a ceiling a read is
 * clamped (the line count, the line length) or refused (anything else), and the answer says which.
 *
 * Each read of lines is recorded as the caller by record_service_logs_read() (0225, 0230), which
 * writes an Audit Trail row only when the parameters differ from the caller's last recorded read, so
 * a refresh writes nothing. The lines are released only once that call has answered.
 */

import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import { gatewayKey } from "../_shared/gatewayKey.ts";
import { serverError } from "../_shared/failure.ts";
import { resolveUserRole } from "../_shared/roles.ts";
import { buildQuery, listServices, readLines, type StoredLine, StoreTimeout } from "./store.ts";

const FN = "service-logs";

/** The rolling ranges a read may ask for, in milliseconds. The keys are the Audit Trail's. */
export const RANGES: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};
export const DEFAULT_RANGE = "1h";

/**
 * The widest window `from` and `to` may name, in hours: 7 days, and the hour a calendar week
 * gains when the clocks go back, so the time control's Week is never refused.
 */
export const LONGEST_WINDOW_HOURS = 169;

/** `any`, or a level read from a JSON line's `level` field. A line that is not JSON has none. */
export const LEVELS = ["any", "error", "warning", "info", "debug"];

/** The ceilings. */
export const MAX_LINES = 500;
export const DEFAULT_LINES = 200;
export const LINE_BYTES = 8 * 1024;
export const UPSTREAM_TIMEOUT_MS = 10_000;
export const FILTER_MAX = 200;
export const SERVICE_MAX = 128;

/** What a line cut at LINE_BYTES ends with. */
export const CUT_MARKER = " … [cut at 8 KiB]";

const PARAMETERS = ["service", "level", "filter", "range", "from", "to", "limit"];
const LONGEST_RANGE = Math.max(...Object.values(RANGES));
const LONGEST_WINDOW = LONGEST_WINDOW_HOURS * 60 * 60_000;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
// deno-lint-ignore no-control-regex -- refusing NUL is the point
const NUL = /\x00/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The JSON fields shown beside a line's message. */
export const FIELDS = ["reason", "device", "edge_node"];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    // no-store: a line can carry an address or an email.
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const refuse = (details: string) => json(400, { error: "The logs were not read", details });

export interface Read {
  service: string;
  level: string;
  filter: string;
  /** A rolling window's key, or null for a fixed window. */
  range: string | null;
  /** A fixed window's ends in milliseconds, `to` the first moment outside it; null when rolling. */
  from: number | null;
  to: number | null;
  limit: number;
  clamped: { parameter: string; asked: number; used: number; why: string }[];
}

/**
 * An ISO 8601 instant with its offset (`2026-11-02T00:00:00Z`, `…+01:00`) in milliseconds, or null.
 * Date.parse alone rolls 30 February into March and reads 24:00, so each part is checked first. A
 * time with no offset names no instant, and one before 1970 no log line.
 */
export function parseInstant(text: string): number | null {
  const m = INSTANT.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, sec = 0, oh = 0, om = 0] = m.slice(1).map((v) => (v === undefined ? 0 : Number(v)));
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > days || h > 23 || mi > 59 || sec > 59 || oh > 23 || om > 59) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** The request's parameters checked against the ceilings, or the answer refusing them. */
export function parseRead(url: URL): Read | Response {
  for (const key of new Set(url.searchParams.keys())) {
    if (!PARAMETERS.includes(key)) {
      return refuse(`${key} is not a parameter. The parameters are ${PARAMETERS.join(", ")}; a query is never accepted.`);
    }
    if (url.searchParams.getAll(key).length > 1) return refuse(`Give ${key} once.`);
  }
  const get = (key: string) => url.searchParams.get(key) ?? "";

  const service = get("service");
  if ([...service].length > SERVICE_MAX) return refuse(`A service name is at most ${SERVICE_MAX} characters.`);

  const level = get("level") || "any";
  if (!LEVELS.includes(level)) return refuse(`level must be one of ${LEVELS.join(", ")}.`);

  // A rolling window is its range, measured back from now; a fixed one is its two ends.
  const fixed = url.searchParams.has("from") || url.searchParams.has("to");
  let range: string | null = null;
  let from: number | null = null;
  let to: number | null = null;
  if (fixed) {
    if (get("range")) return refuse("Give range, or from and to, not both.");
    if (!url.searchParams.has("from") || !url.searchParams.has("to")) {
      return refuse("Give both from and to: a fixed window has two ends.");
    }
    from = parseInstant(get("from"));
    to = parseInstant(get("to"));
    if (from === null || to === null) {
      return refuse("from and to are ISO 8601 instants with an offset, such as 2026-11-02T00:00:00Z.");
    }
    if (to <= from) return refuse("to must be after from.");
    if (to - from > LONGEST_WINDOW) {
      return refuse(
        "from and to are at most 7 days apart, or 7 days and an hour for a week that holds a clock change. " +
          "A read covers at most 7 days.",
      );
    }
  } else {
    range = get("range") || DEFAULT_RANGE;
    if (!Object.hasOwn(RANGES, range)) {
      return refuse(`range must be one of ${Object.keys(RANGES).join(", ")}. A read covers at most 7 days.`);
    }
  }

  const filter = get("filter");
  if ([...filter].length > FILTER_MAX) return refuse(`The filter is at most ${FILTER_MAX} characters.`);
  if (NUL.test(filter) || LONE_SURROGATE.test(filter)) return refuse("The filter must be text, with no NUL character.");

  const clamped: Read["clamped"] = [];
  let limit = DEFAULT_LINES;
  const asked = get("limit");
  if (asked) {
    if (!/^[0-9]{1,9}$/.test(asked) || Number(asked) < 1) return refuse("limit must be a whole number of lines, 1 or more.");
    limit = Number(asked);
    if (limit > MAX_LINES) {
      clamped.push({
        parameter: "limit",
        asked: limit,
        used: MAX_LINES,
        why: `At most ${MAX_LINES} lines are read at a time, so this read shows the newest ${MAX_LINES}.`,
      });
      limit = MAX_LINES;
    }
  }
  return { service, level, filter, range, from, to, limit, clamped };
}

/** `text` cut to LINE_BYTES of UTF-8 at a character boundary, with the marker, and whether it was. */
export function cutText(text: string): [string, boolean] {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= LINE_BYTES) return [text, false];
  let end = LINE_BYTES;
  // A continuation byte belongs to a character that starts before it.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return [new TextDecoder().decode(bytes.subarray(0, end)) + CUT_MARKER, true];
}

export interface ShownLine {
  time: string;
  ns: string;
  level: string | null;
  message: string | null;
  fields: Record<string, string>;
  line: string;
  cut: boolean;
}

const asText = (v: unknown) =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;

/**
 * One line as the tab shows it. A JSON line, as ingestion and playback write, gives its level, its
 * message (with a traceback after it) and the fields the tab names; any other line is its text.
 */
export function shapeLine({ ns, line }: StoredLine): ShownLine {
  let record: Record<string, unknown> | null = null;
  if (line.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) record = parsed;
    } catch {
      record = null;
    }
  }
  let message = record ? asText(record.msg) ?? asText(record.message) : null;
  const exc = record ? asText(record.exc) : null;
  if (exc) message = message ? `${message}\n${exc}` : exc;
  const fields: Record<string, string> = {};
  for (const key of FIELDS) {
    const value = record ? asText(record[key]) : null;
    if (value !== null) fields[key] = value;
  }
  const [shownLine, lineCut] = cutText(line);
  const [shownMessage, messageCut] = message === null ? [null, false] : cutText(message);
  return {
    time: new Date(Number(BigInt(ns) / 1_000_000n)).toISOString(),
    ns,
    level: record ? asText(record.level) : null,
    message: shownMessage,
    fields,
    line: shownLine,
    cut: lineCut || messageCut,
  };
}

/** The answer when the store failed: a timeout says how to narrow the read. */
function storeFailure(req: Request, err: unknown): Response {
  if (err instanceof StoreTimeout) {
    return serverError(req, FN, err, {
      status: 504,
      error: `The log store did not answer within ${UPSTREAM_TIMEOUT_MS / 1000} seconds. Choose a shorter range or a filter.`,
      context: "reading the log store",
    });
  }
  return serverError(req, FN, err, {
    status: 503,
    error: "The log store could not be read. Grafana's Explore page reads the same store.",
    context: "reading the log store",
  });
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return json(405, { error: "Method not allowed", details: "Use GET." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const missing = [!supabaseUrl && "SUPABASE_URL", !gatewayKey() && "SUPABASE_PUBLISHABLE_KEY"].filter(Boolean);
  if (missing.length > 0) {
    console.error(`${FN}: missing ${missing.join(", ")}`);
    return json(500, { error: "The logs are not configured", details: `The server is missing: ${missing.join(", ")}.` });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json(401, { error: "Unauthorized", details: "A signed-in session is required." });
  }

  try {
    // The caller's own token, so the role lookup and the audit row are theirs.
    const caller = createClient(supabaseUrl, gatewayKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authHeader } },
    });
    // GoTrue's check: a person's session. A machine identity's token is refused here, as it should
    // be, since these lines are for a person to read.
    const { data: { user }, error: userError } = await caller.auth.getUser(authHeader.slice("Bearer ".length));
    if (userError || !user) {
      return json(401, { error: "Invalid user token", details: userError?.message });
    }
    if (await resolveUserRole(caller, user.id) !== "Administrator") {
      return json(403, {
        error: "Forbidden: Insufficient privileges",
        details: "Reading the services' logs requires Administrator.",
      });
    }

    const read = parseRead(new URL(req.url));
    if (read instanceof Response) return read;

    const loki = Deno.env.get("LOKI_URL") ?? "";
    if (!loki) {
      return json(200, {
        observability: false,
        details: "Observability is off on this deployment and no external log store is set, so there are no logs to read.",
        services: [],
        lines: [],
      });
    }

    const now = Date.now();
    const [from, to] = read.range === null ? [read.from!, read.to!] : [now - RANGES[read.range], now];
    // The services that wrote in a fixed window, or in the last 7 days for a rolling one, so the list
    // does not shrink at 15 minutes. A read is refused over the same span, which its words name.
    const [listFrom, listTo] = read.range === null ? [from, to] : [now - LONGEST_RANGE, now];
    let services: string[];
    try {
      services = await listServices(loki, listFrom, listTo, UPSTREAM_TIMEOUT_MS);
    } catch (err) {
      return storeFailure(req, err);
    }
    if (!read.service) return json(200, { observability: true, services, lines: [] });
    if (!services.includes(read.service)) {
      const span = read.range === null
        ? `between ${new Date(from).toISOString()} and ${new Date(to).toISOString()}`
        : "in the last 7 days";
      return refuse(`No service called ${JSON.stringify(read.service)} wrote a line ${span}.`);
    }
    let stored: StoredLine[];
    try {
      stored = await readLines(loki, buildQuery(read), from, to, read.limit, UPSTREAM_TIMEOUT_MS);
    } catch (err) {
      return storeFailure(req, err);
    }

    // What was asked for: a rolling window's key, never the times it resolved to, so the same read
    // a minute later is the same read; a fixed window's ends, so a repeat of it is too.
    const { data: recorded, error: recordError } = await caller.rpc("record_service_logs_read", {
      p_service: read.service,
      p_level: read.level,
      p_filter: read.filter,
      p_range: read.range,
      ...(read.range === null ? { p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString() } : {}),
    });
    if (recordError) {
      return serverError(req, FN, recordError, {
        status: 503,
        error: "The read could not be recorded in the Audit Trail, so no lines are shown.",
        context: "recording a read of the service logs",
      });
    }

    return json(200, {
      observability: true,
      services,
      service: read.service,
      level: read.level,
      filter: read.filter,
      range: read.range,
      limit: read.limit,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      lines: stored.map(shapeLine),
      more: stored.length === read.limit,
      clamped: read.clamped,
      audit: recorded === null ? "unchanged" : "recorded",
    });
  } catch (err) {
    return serverError(req, FN, err);
  }
}
