/**
 * Everything that knows the log store's API: the query each read becomes, the list of services,
 * and the shape of an answer. Loki today: a later store replaces this file and nothing else, so
 * nothing outside it names LogQL, a Loki path or Loki's answer.
 *
 * The query has one shape, built here from parameters the handler has already checked:
 *
 *   {service="<service>"} [|= "<filter>"] [| json aber_level="level" | aber_level=~"(?i)(?:…)"]
 *
 * Every caller value is a quoted string literal, so a filter cannot add a stage or a selector.
 */

/** The levels a read can ask for, and the spellings in a JSON line's `level` each one matches. */
export const LEVEL_SPELLINGS: Record<string, readonly string[]> = {
  error: ["error", "err", "critical", "crit", "fatal", "panic"],
  warning: ["warning", "warn"],
  info: ["info", "notice"],
  debug: ["debug", "trace"],
};

export class StoreUnavailable extends Error {}
export class StoreTimeout extends Error {}

/**
 * `text` as a LogQL double-quoted string. LogQL reads one with Go's strconv.Unquote, so a quote and
 * a backslash are escaped, and a line break or another control character is written as an escape:
 * a literal newline ends the string. A lone UTF-16 surrogate has no escape Go accepts; the handler
 * refuses one before it reaches here, and this throws rather than guess.
 */
export function logqlString(text: string): string {
  let out = '"';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp >= 0xd800 && cp <= 0xdfff) throw new RangeError("a lone surrogate cannot be quoted");
    else out += ch;
  }
  return `${out}"`;
}

/** The query for one read: the service's stream, the text filter, then the level. */
export function buildQuery({ service, level, filter }: { service: string; level: string; filter: string }): string {
  let query = `{service=${logqlString(service)}}`;
  if (filter) query += ` |= ${logqlString(filter)}`;
  const spellings = LEVEL_SPELLINGS[level];
  if (spellings) {
    // A label of its own name, so a stream label called `level` on another collector's store is
    // not renamed under it. A line that is not JSON has no such label and never matches.
    query += ` | json aber_level="level" | aber_level=~${logqlString(`(?i)(?:${spellings.join("|")})`)}`;
  }
  return query;
}

/** Nanoseconds since the epoch, as Loki takes a time. */
const nanos = (ms: number) => `${BigInt(Math.trunc(ms)) * 1_000_000n}`;

async function get(base: string, path: string, params: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const url = `${base.replace(/\/+$/, "")}${path}?${new URLSearchParams(params)}`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new StoreTimeout(`the log store did not answer ${path} within ${timeoutMs} ms`);
    }
    throw new StoreUnavailable(`the log store could not be reached: ${err instanceof Error ? err.message : err}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new StoreUnavailable(`the log store answered ${path} with ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new StoreUnavailable(`the log store answered ${path} with something that is not JSON`);
  }
}

/** Every service that wrote a line between `fromMs` and `toMs`, sorted. */
export async function listServices(base: string, fromMs: number, toMs: number, timeoutMs: number): Promise<string[]> {
  const body = await get(base, "/loki/api/v1/label/service/values",
    { start: nanos(fromMs), end: nanos(toMs) }, timeoutMs) as { data?: unknown };
  const values = Array.isArray(body?.data) ? body.data : [];
  return values.filter((v): v is string => typeof v === "string" && v.length > 0).sort();
}

/** One line as the store holds it: when it was written, in nanoseconds, and the text. */
export interface StoredLine {
  ns: string;
  line: string;
}

/**
 * The newest `limit` lines of a read, newest first. Loki answers one stream per label set (the
 * level stage splits a service's lines by level), so the streams are merged here.
 */
export function parseLines(body: unknown, limit: number): StoredLine[] {
  const result = (body as { data?: { result?: unknown } })?.data?.result;
  if (!Array.isArray(result)) throw new StoreUnavailable("the log store's answer holds no result list");
  const lines: StoredLine[] = [];
  for (const stream of result) {
    const values = (stream as { values?: unknown })?.values;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (Array.isArray(value) && /^\d+$/.test(String(value[0])) && typeof value[1] === "string") {
        lines.push({ ns: String(value[0]), line: value[1] });
      }
    }
  }
  lines.sort((a, b) => (BigInt(b.ns) > BigInt(a.ns) ? 1 : BigInt(b.ns) < BigInt(a.ns) ? -1 : 0));
  return lines.slice(0, limit);
}

/** The newest `limit` lines of `query` between `fromMs` and `toMs`. */
export async function readLines(
  base: string,
  query: string,
  fromMs: number,
  toMs: number,
  limit: number,
  timeoutMs: number,
): Promise<StoredLine[]> {
  const body = await get(base, "/loki/api/v1/query_range", {
    query,
    start: nanos(fromMs),
    end: nanos(toMs),
    limit: String(limit),
    direction: "backward",
  }, timeoutMs);
  return parseLines(body, limit);
}
