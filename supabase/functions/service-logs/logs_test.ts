import {
  CUT_MARKER,
  cutText,
  DEFAULT_LINES,
  FILTER_MAX,
  handler,
  LINE_BYTES,
  LONGEST_WINDOW_HOURS,
  MAX_LINES,
  parseInstant,
  RANGES,
  shapeLine,
} from "./logs.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
  ok(value: unknown, message = "") {
    if (!value) throw new Error(message || `expected a truthy value, got ${JSON.stringify(value)}`);
  },
};

const BASE = "http://gateway.test";
const LOKI = "http://loki.test:3100";
const CALLER_TOKEN = "caller-session-token";
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";

type Reply = { status: number; body: unknown; raw?: string };
type Call = { method: string; host: string; path: string; params: Record<string, string>; body: unknown; auth: string | null };

/** A JSON line as ingestion writes one. */
const DROP = JSON.stringify({
  reason: "quarantined_or_unregistered", device: "dev0a1b2c3d4e5f6071829", edge_node: "gwy01",
  ts: "2026-11-03T10:00:00Z", level: "WARNING", logger: "ingestion", msg: "Dropped a DDATA",
});

/**
 * GoTrue, PostgREST and Loki, answered from `replies` keyed "METHOD /path". The caller is an
 * Administrator unless `role` says otherwise. The record function writes a row only when the
 * parameters differ from the caller's last recorded ones, as 0225 does, so a sequence of requests
 * shows what the handler sends it. Every request is recorded in order.
 */
function stack(replies: Record<string, Reply> = {}, role: string | null = "Administrator") {
  const calls: Call[] = [];
  let last: string | null = null;
  let rows = 0;
  const defaults: Record<string, Reply> = {
    "GET /auth/v1/user": { status: 200, body: { id: ADMIN_ID, aud: "authenticated", email: "admin@site.test" } },
    "GET /rest/v1/user_roles": { status: 200, body: role ? [{ roles: { name: role } }] : [] },
    "GET /loki/api/v1/label/service/values": { status: 200, body: { status: "success", data: ["auth", "ingestion", "mosquitto"] } },
    "GET /loki/api/v1/query_range": {
      status: 200,
      body: {
        status: "success",
        data: {
          resultType: "streams",
          result: [{ stream: { service: "ingestion" }, values: [["1793700000000000000", DROP], ["1793699999000000000", "plain text line"]] }],
        },
      },
    },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const text = await req.text();
    const body = text ? JSON.parse(text) : null;
    calls.push({
      method: req.method,
      host: url.host,
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
      body,
      auth: req.headers.get("Authorization"),
    });
    const key = `${req.method} ${url.pathname}`;
    let reply = replies[key] ?? defaults[key];
    if (!reply && key === "POST /rest/v1/rpc/record_service_logs_read") {
      const read = JSON.stringify(body);
      reply = read === last ? { status: 200, body: null } : { status: 200, body: ++rows };
      last = read;
    }
    reply ??= { status: 599, body: { message: `unexpected ${key}` } };
    return new Response(reply.raw ?? (reply.body === null ? "null" : JSON.stringify(reply.body)), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    calls,
    rows: () => rows,
    paths: () => calls.map((c) => `${c.method} ${c.path}`),
    toLoki: () => calls.filter((c) => c.host === new URL(LOKI).host),
    records: () => calls.filter((c) => c.path === "/rest/v1/rpc/record_service_logs_read"),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function env({ loki = true } = {}) {
  Deno.env.set("SUPABASE_URL", BASE);
  Deno.env.set("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  if (loki) Deno.env.set("LOKI_URL", `${LOKI}/`);
  else Deno.env.delete("LOKI_URL");
}

function get(query = "", token: string | null = CALLER_TOKEN): Request {
  return new Request(`${BASE}/service-logs${query ? `?${query}` : ""}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

/** Runs one request against a stubbed stack with console.error captured. */
async function run(request: Request, s: ReturnType<typeof stack>, { keep = false } = {}) {
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const response = await handler(request);
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null, logged };
  } finally {
    console.error = originalError;
    if (!keep) s.restore();
  }
}

Deno.test("anything but GET is refused, and a preflight is answered", async () => {
  env();
  assert.equal((await handler(new Request(`${BASE}/service-logs`, { method: "OPTIONS" }))).status, 200);
  const post = await handler(new Request(`${BASE}/service-logs`, { method: "POST", body: "{}" }));
  assert.equal(post.status, 405);
  await post.body?.cancel();
});

Deno.test("a deployment without the gateway's address names what it lacks", async () => {
  env();
  Deno.env.delete("SUPABASE_URL");
  const s = stack();
  const { response, body } = await run(get("service=ingestion"), s);
  assert.equal(response.status, 500);
  assert.ok(String(body.details).includes("SUPABASE_URL"));
  assert.equal(s.calls.length, 0);
});

Deno.test("anonymous: no session, or the publishable key in its place, reads nothing", async () => {
  env();
  let s = stack();
  let { response } = await run(get("service=ingestion", null), s);
  assert.equal(response.status, 401);
  assert.equal(s.calls.length, 0);

  env();
  s = stack({ "GET /auth/v1/user": { status: 401, body: { code: 401, msg: "invalid JWT" } } });
  ({ response } = await run(get("service=ingestion", "publishable-key"), s));
  assert.equal(response.status, 401);
  assert.equal(s.toLoki(), []);
  assert.equal(s.records(), []);
});

Deno.test("Operator, Auditor and Shopfloor_Manager are refused before the store is asked anything", async () => {
  for (const role of ["Operator", "Auditor", "Shopfloor_Manager", null]) {
    env();
    const s = stack({}, role);
    const { response, body } = await run(get("service=ingestion"), s);
    assert.equal(response.status, 403, String(role));
    assert.ok(/Administrator/.test(body.details), String(role));
    assert.equal(s.paths(), ["GET /auth/v1/user", "GET /rest/v1/user_roles"], String(role));
  }
});

Deno.test("with no log store set, an Administrator is told observability is off", async () => {
  env({ loki: false });
  const s = stack();
  const { response, body } = await run(get("service=ingestion"), s);
  assert.equal(response.status, 200);
  assert.equal(body.observability, false);
  assert.ok(/observability is off/i.test(body.details));
  assert.equal(body.lines, []);
  assert.equal(s.toLoki(), []);
  assert.equal(s.records(), []);
});

Deno.test("with no service, the answer is the list of services and no row", async () => {
  env();
  const s = stack();
  const { response, body } = await run(get(), s);
  assert.equal(response.status, 200);
  assert.equal(body, { observability: true, services: ["auth", "ingestion", "mosquitto"], lines: [] });
  assert.equal(s.toLoki().map((c) => c.path), ["/loki/api/v1/label/service/values"]);
  // Listed over the longest range a read may ask for.
  const { start, end } = s.toLoki()[0].params;
  assert.equal(String((BigInt(end) - BigInt(start)) / 1_000_000n), String(RANGES["7d"]));
  assert.equal(s.records(), []);
});

Deno.test("a query, or any parameter that is not one, is refused before the store is asked", async () => {
  for (const query of [
    'query={service=~".%2B"}',
    "service=ingestion&logql=x",
    "service=ingestion&service=auth",
    "service=ingestion&level=critical",
    "service=ingestion&range=30d",
    "service=ingestion&range=1h30m",
    "service=ingestion&limit=0",
    "service=ingestion&limit=-5",
    "service=ingestion&limit=ten",
    `service=ingestion&filter=${"x".repeat(FILTER_MAX + 1)}`,
    "service=ingestion&filter=a%00b",
    `service=${"s".repeat(129)}`,
  ]) {
    env();
    const s = stack();
    const { response } = await run(get(query), s);
    assert.equal(response.status, 400, query);
    assert.equal(s.toLoki(), [], query);
    assert.equal(s.records(), [], query);
  }
});

Deno.test("a service the store does not list is refused with no read and no row", async () => {
  env();
  const s = stack();
  const { response, body } = await run(get(`service=${encodeURIComponent('ingestion"} or {service="auth')}`), s);
  assert.equal(response.status, 400);
  assert.ok(/7 days/.test(body.details));
  assert.equal(s.toLoki().map((c) => c.path), ["/loki/api/v1/label/service/values"]);
  assert.equal(s.records(), []);
});

Deno.test("an Administrator reads a service's lines: the query is built here, the row as the caller, the lines last", async () => {
  env();
  const s = stack();
  const filter = 'dev01" |= "x';
  const { response, body } = await run(get(`service=ingestion&level=warning&range=6h&filter=${encodeURIComponent(filter)}`), s);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  const read = s.toLoki().find((c) => c.path === "/loki/api/v1/query_range")!;
  assert.equal(
    read.params.query,
    '{service="ingestion"} |= "dev01\\" |= \\"x" | json aber_level="level" | aber_level=~"(?i)(?:warning|warn)"',
  );
  assert.equal(read.params.direction, "backward");
  assert.equal(read.params.limit, String(DEFAULT_LINES));
  assert.equal(String((BigInt(read.params.end) - BigInt(read.params.start)) / 1_000_000n), String(RANGES["6h"]));

  const [record] = s.records();
  assert.equal(record.auth, `Bearer ${CALLER_TOKEN}`, "recorded as the caller");
  assert.equal(record.body, { p_service: "ingestion", p_level: "warning", p_filter: filter, p_range: "6h" });
  assert.ok(s.paths().indexOf("GET /loki/api/v1/query_range") < s.paths().indexOf("POST /rest/v1/rpc/record_service_logs_read"));

  assert.equal(body.audit, "recorded");
  assert.equal([body.service, body.level, body.filter, body.range, body.limit], ["ingestion", "warning", filter, "6h", DEFAULT_LINES]);
  assert.equal(body.more, false);
  assert.equal(body.clamped, []);
  assert.equal(body.lines.map((l: { line: string }) => l.line), [DROP, "plain text line"]);
  assert.equal(body.lines[0], {
    time: "2026-11-03T10:00:00.000Z",
    ns: "1793700000000000000",
    level: "WARNING",
    message: "Dropped a DDATA",
    fields: { reason: "quarantined_or_unregistered", device: "dev0a1b2c3d4e5f6071829", edge_node: "gwy01" },
    line: DROP,
    cut: false,
  });
  assert.equal([body.lines[1].level, body.lines[1].message, body.lines[1].fields], [null, null, {}]);
});

Deno.test("a row on the first load and on each change, none on a refresh or a repeated direct call", async () => {
  env();
  const s = stack();
  const audits: string[] = [];
  for (const query of [
    "service=ingestion",                          // the tab's first load
    "service=ingestion",                          // a refresh, or a poll
    "service=ingestion&range=1h",                 // the same read, the default spelled out
    "service=ingestion&filter=dev01",             // a filter typed
    "service=ingestion&filter=dev01&limit=50",    // the line count is not part of a read's identity
    "service=ingestion&filter=dev01&level=error", // a level picked
    "service=auth&filter=dev01&level=error",      // another service
    "service=auth&filter=dev01&level=error",      // the same request again, straight to the API
  ]) {
    const { body } = await run(get(query), s, { keep: true });
    audits.push(body.audit);
  }
  s.restore();
  assert.equal(audits, ["recorded", "unchanged", "unchanged", "recorded", "unchanged", "recorded", "recorded", "unchanged"]);
  assert.equal(s.rows(), 4);
  // The handler sends the parameters as read, never resolved times, so a repeat is the same read.
  assert.equal(new Set(s.records().map((r) => JSON.stringify(r.body))).size, 4);
});

Deno.test("a fixed window is read between its ends, recorded as them, and answered with them", async () => {
  env();
  const s = stack();
  const { response, body } = await run(get("service=ingestion&level=error&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z"), s);
  assert.equal(response.status, 200);

  const read = s.toLoki().find((c) => c.path === "/loki/api/v1/query_range")!;
  assert.equal([read.params.start, read.params.end], [`${Date.UTC(2026, 10, 1)}000000`, `${Date.UTC(2026, 10, 2)}000000`]);
  // The service list is still the last 7 days', whatever the window.
  const listed = s.toLoki().find((c) => c.path === "/loki/api/v1/label/service/values")!;
  assert.equal(String((BigInt(listed.params.end) - BigInt(listed.params.start)) / 1_000_000n), String(RANGES["7d"]));

  const [record] = s.records();
  assert.equal(record.body, {
    p_service: "ingestion", p_level: "error", p_filter: "", p_range: null,
    p_from: "2026-11-01T00:00:00.000Z", p_to: "2026-11-02T00:00:00.000Z",
  });
  assert.equal([body.range, body.from, body.to, body.audit], [null, "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", "recorded"]);
});

Deno.test("an instant written with an offset is the same instant, and recorded in UTC", async () => {
  env();
  const s = stack();
  const { response } = await run(get(`service=ingestion&from=${encodeURIComponent("2026-11-01T01:00+01:00")}&to=2026-11-01T06:30:15.250Z`), s);
  assert.equal(response.status, 200);
  const sent = s.records()[0].body as Record<string, unknown>;
  assert.equal([sent.p_from, sent.p_to], ["2026-11-01T00:00:00.000Z", "2026-11-01T06:30:15.250Z"]);
  assert.equal(parseInstant("2026-02-28T23:59:59.999Z"), Date.UTC(2026, 1, 28, 23, 59, 59, 999));
  assert.equal(parseInstant("2028-02-29T00:00Z"), Date.UTC(2028, 1, 29));
});

Deno.test("a week that holds a clock change, 7 days and an hour, is read", async () => {
  env();
  const s = stack();
  // London's week of 19 October 2026: Monday's midnight is BST's, the next Monday's GMT's.
  const { response } = await run(get("service=ingestion&from=2026-10-18T23:00:00Z&to=2026-10-26T00:00:00Z"), s);
  assert.equal(response.status, 200);
  assert.equal(LONGEST_WINDOW_HOURS, 7 * 24 + 1);
});

Deno.test("a window that is not two ends in order, at most 7 days and an hour apart, is refused before the store is asked", async () => {
  for (const [query, reason] of [
    ["from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&range=1h", /not both/],
    ["from=2026-11-01T00:00:00Z", /both from and to/],
    ["to=2026-11-02T00:00:00Z", /both from and to/],
    ["from=&to=2026-11-02T00:00:00Z", /ISO 8601/],
    ["from=2026-11-01T00:00&to=2026-11-02T00:00", /with an offset/],
    ["from=2026-11-01&to=2026-11-02", /ISO 8601/],
    ["from=2026-02-30T00:00:00Z&to=2026-03-01T00:00:00Z", /ISO 8601/],
    ["from=2026-11-01T00:00:00Z&to=2026-11-01T24:00:00Z", /ISO 8601/],
    ["from=2026-11-01T00:00:00Z&to=2026-11-01T10:00:00%2B24:00", /ISO 8601/],
    ["from=1969-12-31T00:00:00Z&to=1970-01-01T00:00:00Z", /ISO 8601/],
    ["from=2026-11-02T00:00:00Z&to=2026-11-02T00:00:00Z", /after from/],
    ["from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z", /after from/],
    ["from=2026-10-18T23:00:00Z&to=2026-10-26T00:00:00.001Z", /at most 7 days/],
    ["from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z", /at most 7 days/],
  ] as const) {
    env();
    const s = stack();
    const { response, body } = await run(get(`service=ingestion&${query}`), s);
    assert.equal(response.status, 400, query);
    assert.ok(reason.test(body.details), `${query}: ${body.details}`);
    assert.equal(s.toLoki(), [], query);
    assert.equal(s.records(), [], query);
  }
});

Deno.test("a fixed window repeated is the same read, and a step or a change of window is a new one", async () => {
  env();
  const s = stack();
  const yesterday = "from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z";
  const audits: string[] = [];
  for (const query of [
    "service=ingestion",                                         // Last 1 hour, the tab's first load
    "service=ingestion&range=1h",                                // a poll of Last 1 hour
    `service=ingestion&${yesterday}`,                            // stepped to yesterday
    `service=ingestion&${yesterday}`,                            // a refresh of yesterday
    "service=ingestion&from=2026-11-01T00:00:00.000%2B00:00&to=2026-11-02T00:00Z", // the same instants, spelt otherwise
    "service=ingestion&from=2026-10-31T00:00:00Z&to=2026-11-01T00:00:00Z", // the day before
    "service=ingestion&range=1h",                                // back to Last 1 hour
    "service=ingestion&range=1h",                                // and a poll of it
  ]) {
    const { body } = await run(get(query), s, { keep: true });
    audits.push(body.audit);
  }
  s.restore();
  assert.equal(audits, ["recorded", "unchanged", "recorded", "unchanged", "unchanged", "recorded", "recorded", "unchanged"]);
  assert.equal(s.rows(), 4);
});

Deno.test("a limit over the ceiling is clamped, and the answer says so and why", async () => {
  env();
  const s = stack();
  const { response, body } = await run(get("service=ingestion&limit=900"), s);
  assert.equal(response.status, 200);
  assert.equal(s.toLoki().find((c) => c.path === "/loki/api/v1/query_range")!.params.limit, String(MAX_LINES));
  assert.equal(body.limit, MAX_LINES);
  assert.equal(body.clamped.length, 1);
  assert.equal([body.clamped[0].parameter, body.clamped[0].asked, body.clamped[0].used], ["limit", 900, MAX_LINES]);
  assert.ok(body.clamped[0].why.includes(`newest ${MAX_LINES}`));
});

Deno.test("a read that fills its limit says older lines were left out", async () => {
  env();
  const s = stack();
  const { body } = await run(get("service=ingestion&limit=2"), s);
  assert.equal([body.lines.length, body.more], [2, true]);
});

Deno.test("no row, no lines: a read the Audit Trail could not record is refused", async () => {
  env();
  const s = stack({ "POST /rest/v1/rpc/record_service_logs_read": { status: 400, body: { code: "42501", message: "nope" } } });
  const { response, body, logged } = await run(get("service=ingestion"), s);
  assert.equal(response.status, 503);
  assert.equal(body.lines, undefined);
  assert.ok(!JSON.stringify(body).includes("Dropped a DDATA"));
  assert.ok(!JSON.stringify(body).includes("nope"), "the database's message reached the caller");
  assert.ok(logged.join("\n").includes("nope"), "the database's message is logged");
});

Deno.test("a store that is down is a 503 with a fixed sentence, and records nothing", async () => {
  env();
  const s = stack({ "GET /loki/api/v1/query_range": { status: 500, body: null, raw: "internal: ring not ready at 10.42.0.7:9095" } });
  const { response, body, logged } = await run(get("service=ingestion"), s);
  assert.equal(response.status, 503);
  assert.ok(!JSON.stringify(body).includes("10.42.0.7"), "an internal address reached the caller");
  assert.ok(logged.join("\n").includes("10.42.0.7"), "the store's answer is logged");
  assert.equal(s.records(), []);
});

Deno.test("a store that does not answer in 10 seconds is a 504 that says how to narrow the read", async () => {
  env();
  const s = stack();
  const stubbed = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) =>
    new URL(input instanceof Request ? input.url : String(input)).host === new URL(LOKI).host
      ? Promise.reject(new DOMException("Signal timed out.", "TimeoutError"))
      : stubbed(input, init);
  const { response, body } = await run(get("service=ingestion"), s);
  assert.equal(response.status, 504);
  assert.ok(/10 seconds/.test(body.error) && /shorter range or a filter/.test(body.error), body.error);
  assert.equal(s.records(), []);
});

Deno.test("a line over 8 KiB is cut at a character boundary, with a marker", () => {
  const short = "x".repeat(LINE_BYTES);
  assert.equal(cutText(short), [short, false]);

  // Three-byte characters straddling the limit: the cut falls before the one it would split.
  const long = "a" + "€".repeat(LINE_BYTES);
  const [text, cut] = cutText(long);
  assert.ok(cut);
  assert.ok(text.endsWith(CUT_MARKER));
  const kept = text.slice(0, -CUT_MARKER.length);
  assert.ok(new TextEncoder().encode(kept).length <= LINE_BYTES);
  assert.ok(!kept.includes("�"), "a character was split");
  assert.equal(kept, "a" + "€".repeat((LINE_BYTES - 1) / 3 | 0));
});

Deno.test("a JSON line gives its level, message, traceback and named fields; anything else is its text", () => {
  const traceback = JSON.stringify({ level: "ERROR", msg: "crashed", exc: "Traceback (most recent call last):\n  File \"x\"", device: 7 });
  const shown = shapeLine({ ns: "1793700000123000000", line: traceback });
  assert.equal(shown.time, "2026-11-03T10:00:00.123Z");
  assert.equal(shown.message, "crashed\nTraceback (most recent call last):\n  File \"x\"");
  assert.equal(shown.fields, { device: "7" });

  // Untrusted text is returned as text: the tab renders it, and nothing here interprets it.
  for (const line of ['<img src=x onerror="alert(1)">', '{"msg": "<script>x</script>", "level": {"nested": 1}}', "{not json", "[1,2]"]) {
    const s = shapeLine({ ns: "1", line });
    assert.equal(s.line, line);
  }
  assert.equal(shapeLine({ ns: "1", line: '{"msg": "<script>x</script>", "level": {"nested": 1}}' }).level, null);
  assert.equal(shapeLine({ ns: "1", line: "{not json" }).message, null);
});
