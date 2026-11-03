import {
  buildQuery,
  LEVEL_SPELLINGS,
  listServices,
  logqlString,
  parseLines,
  readLines,
  StoreTimeout,
  StoreUnavailable,
} from "./store.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
  ok(value: unknown, message = "") {
    if (!value) throw new Error(message || `expected a truthy value, got ${JSON.stringify(value)}`);
  },
  async rejects(fn: () => Promise<unknown>, type: new (...args: never[]) => Error, message = "") {
    try {
      await fn();
    } catch (err) {
      if (err instanceof type) return;
      throw new Error(`${message ? `${message}: ` : ""}expected ${type.name}, got ${err}`);
    }
    throw new Error(`${message ? `${message}: ` : ""}expected ${type.name}, nothing was thrown`);
  },
};

/**
 * A double-quoted string as Go's strconv.Unquote reads it, which is how LogQL reads one, for the
 * escapes logqlString writes. Throws where Go would: a raw newline, an unknown escape, a quote
 * that ends the string early.
 */
function goUnquote(literal: string): string {
  if (literal.length < 2 || literal[0] !== '"' || literal[literal.length - 1] !== '"') throw new Error("not quoted");
  const body = literal.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\n") throw new Error("a raw newline in a quoted string");
    if (c === '"') throw new Error("an unescaped quote inside the string");
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = body[++i];
    const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' };
    if (e in simple) out += simple[e];
    else if (e === "x") {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else throw new Error(`an escape Go does not accept: \\${e}`);
  }
  return out;
}

/** The query's tokens outside its string literals, so an operator inside a string is not counted. */
function outsideStrings(query: string): string {
  return query.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

const HOSTILE = [
  "plain words",
  "C:\\path\\to\\file",
  'she said "hello"',
  "a `backtick` here",
  "two\nlines",
  "a\ttab and a\rreturn",
  "a bell \x07 and a delete \x7f",
  '"} |= "anything',
  'x" |= "y',
  'x" or "y',
  '"} | line_format "{{.password}}" | json | {service=~".+',
  "\\\"",
  "trailing backslash \\",
  "émoji 🦀 and ąčę",
];

Deno.test("a string reads back as itself, whatever it holds", () => {
  for (const text of HOSTILE) {
    const quoted = logqlString(text);
    assert.equal(goUnquote(quoted), text, JSON.stringify(text));
    assert.ok(!quoted.slice(1, -1).includes("\n"), `a raw newline in ${quoted}`);
  }
});

Deno.test("a lone surrogate is refused rather than quoted", () => {
  let threw = false;
  try {
    logqlString("half \uD83E a crab");
  } catch {
    threw = true;
  }
  assert.ok(threw);
});

Deno.test("a filter stays one line filter: no stage, selector or second filter gets out", () => {
  for (const filter of HOSTILE) {
    const query = buildQuery({ service: "ingestion", level: "any", filter });
    assert.equal(outsideStrings(query), '{service=""} |= ""', filter);
    const [, literal] = query.match(/ \|= ("(?:[^"\\]|\\.)*")$/) ?? [];
    assert.equal(goUnquote(literal), filter, filter);
  }
});

Deno.test("the service is a quoted value too", () => {
  const query = buildQuery({ service: 'ingestion"} or {service="auth', level: "any", filter: "" });
  assert.equal(outsideStrings(query), '{service=""}');
  assert.equal(goUnquote(query.slice("{service=".length, -1)), 'ingestion"} or {service="auth');
});

Deno.test("no filter and any level is the service's stream alone", () => {
  assert.equal(buildQuery({ service: "mosquitto", level: "any", filter: "" }), '{service="mosquitto"}');
});

Deno.test("a level reads the JSON field into a label of its own, after the text filter", () => {
  assert.equal(
    buildQuery({ service: "ingestion", level: "warning", filter: "dev01" }),
    '{service="ingestion"} |= "dev01" | json aber_level="level" | aber_level=~"(?i)(?:warning|warn)"',
  );
  for (const level of Object.keys(LEVEL_SPELLINGS)) {
    const query = buildQuery({ service: "auth", level, filter: "" });
    assert.equal(outsideStrings(query), '{service=""} | json aber_level="" | aber_level=~""', level);
  }
  assert.equal(Object.keys(LEVEL_SPELLINGS), ["error", "warning", "info", "debug"]);
});

Deno.test("streams are merged newest first and cut at the limit", () => {
  const body = {
    status: "success",
    data: {
      resultType: "streams",
      result: [
        { stream: { service: "ingestion", aber_level: "INFO" }, values: [["1700000000000000300", "c"], ["1700000000000000100", "a"]] },
        { stream: { service: "ingestion", aber_level: "WARNING" }, values: [["1700000000000000200", "b"], ["not a time", "x"], ["1700000000000000050", 42]] },
        { stream: {}, values: "not a list" },
      ],
    },
  };
  assert.equal(parseLines(body, 10).map((l) => l.line), ["c", "b", "a"]);
  assert.equal(parseLines(body, 2).map((l) => l.ns), ["1700000000000000300", "1700000000000000200"]);
});

Deno.test("an answer with no result list is the store failing, not an empty read", async () => {
  for (const body of [{}, { data: {} }, { data: { result: "x" } }, null]) {
    await assert.rejects(() => Promise.resolve().then(() => parseLines(body, 10)), StoreUnavailable, JSON.stringify(body));
  }
});

type Seen = { path: string; params: Record<string, string> };

function loki(reply: (path: string) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    assert.ok(init?.signal, "every request to the store carries a timeout");
    return Promise.resolve(reply(url.pathname));
  };
  return { seen, restore: () => (globalThis.fetch = original) };
}

Deno.test("the services are the label's values over the window, sorted", async () => {
  const s = loki(() => new Response(JSON.stringify({ status: "success", data: ["playback", "auth", "", 7, "ingestion"] })));
  try {
    const services = await listServices("http://loki:3100/", 1_000, 2_000, 10_000);
    assert.equal(services, ["auth", "ingestion", "playback"]);
    assert.equal(s.seen, [{ path: "/loki/api/v1/label/service/values", params: { start: "1000000000", end: "2000000000" } }]);
  } finally {
    s.restore();
  }
});

Deno.test("a read asks for the newest lines in the window, backward, at the limit", async () => {
  const s = loki(() => new Response(JSON.stringify({ data: { result: [] } })));
  try {
    await readLines("http://loki:3100", '{service="auth"}', 1_000, 2_000, 500, 10_000);
    assert.equal(s.seen, [{
      path: "/loki/api/v1/query_range",
      params: { query: '{service="auth"}', start: "1000000000", end: "2000000000", limit: "500", direction: "backward" },
    }]);
  } finally {
    s.restore();
  }
});

Deno.test("a store that refuses, answers nonsense or cannot be reached is unavailable", async () => {
  for (const reply of [
    () => new Response("parse error at line 1", { status: 400 }),
    () => new Response("too many outstanding requests", { status: 429 }),
    () => new Response("<html>bad gateway</html>", { status: 200 }),
    () => Promise.reject(new TypeError("connection refused")),
  ]) {
    const s = loki(reply);
    try {
      await assert.rejects(() => readLines("http://loki:3100", '{service="auth"}', 1, 2, 10, 10_000), StoreUnavailable);
    } finally {
      s.restore();
    }
  }
});

Deno.test("a store that does not answer in time is a timeout", async () => {
  const s = loki(() => Promise.reject(new DOMException("Signal timed out.", "TimeoutError")));
  try {
    await assert.rejects(() => listServices("http://loki:3100", 1, 2, 10_000), StoreTimeout);
  } finally {
    s.restore();
  }
});
