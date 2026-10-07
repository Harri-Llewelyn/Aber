import { REQUEST_ID_HEADER, requestIdOf, SERVER_FAILURE, serverError } from "./failure.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
  ok(value: unknown, message: string) {
    if (!value) throw new Error(message);
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GATEWAY_ID = "6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b";

/** What the error says, which must reach the log and must not reach the caller. */
const INSIDE = 'relation "gateway_secrets" does not exist (host db.internal.example)';

const request = (headers: Record<string, string> = {}) =>
  new Request("http://functions.test/example", { headers });

/** Runs `fn` with console.error captured, and returns what was logged with its result. */
function capturing<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { result: fn(), lines };
  } finally {
    console.error = original;
  }
}

Deno.test("the gateway's request id is reused in the body, the header and the log", async () => {
  const { result, lines } = capturing(() =>
    serverError(request({ "X-Request-Id": GATEWAY_ID }), "example", new Error(INSIDE))
  );
  const body = await result.json();
  assert.equal(body.request_id, GATEWAY_ID, "the body's id");
  assert.equal(result.headers.get(REQUEST_ID_HEADER), GATEWAY_ID, "the header's id");
  assert.equal(JSON.parse(lines[0]).request_id, GATEWAY_ID, "the log line's id");
});

Deno.test("an id is generated when the request carries none", async () => {
  const { result } = capturing(() => serverError(request(), "example", new Error(INSIDE)));
  const body = await result.json();
  assert.ok(UUID.test(body.request_id), `expected a UUID, got ${body.request_id}`);
  assert.equal(result.headers.get(REQUEST_ID_HEADER), body.request_id, "the header and the body agree");
});

Deno.test("an id is generated when the one sent is malformed", () => {
  for (const sent of ["short", "has a space in it", "quote\"and<angle>", "x".repeat(129)]) {
    const id = requestIdOf(request({ "X-Request-Id": sent }));
    assert.ok(UUID.test(id), `'${sent}' was reused as ${id}`);
  }
  assert.ok(UUID.test(requestIdOf(null)), "no request at all");
  // A shape another proxy might send (32 hex characters) is reused as it is.
  assert.equal(requestIdOf(request({ "x-request-id": "0123456789abcdef0123456789abcdef" })),
    "0123456789abcdef0123456789abcdef", "a well-formed id that is not a UUID");
});

Deno.test("the body carries a fixed sentence and the id, and nothing from the error", async () => {
  const { result } = capturing(() => serverError(request(), "example", new Error(INSIDE)));
  const text = await result.text();
  assert.ok(!text.includes("gateway_secrets") && !text.includes("db.internal"), `the body leaks the error: ${text}`);
  assert.equal(Object.keys(JSON.parse(text)).sort(), ["error", "request_id"], "the body's keys");
  assert.equal(JSON.parse(text).error, SERVER_FAILURE, "the default sentence");
  assert.equal(result.status, 500, "the default status");
  assert.equal(result.headers.get("Content-Type"), "application/json", "the content type");
});

Deno.test("a call site keeps its status and its own fixed sentence", async () => {
  const { result } = capturing(() =>
    serverError(request(), "example", new Error(INSIDE), { status: 502, error: "Could not reach the forge" })
  );
  assert.equal(result.status, 502, "the status");
  assert.equal((await result.json()).error, "Could not reach the forge", "the sentence");
});

Deno.test("the log line is one JSON object with the function, the context, the message and the stack", () => {
  const { lines } = capturing(() =>
    serverError(request({ "X-Request-Id": GATEWAY_ID }), "example", new Error(INSIDE), { context: "reading a gateway" })
  );
  assert.equal(lines.length, 1, "one line per failure");
  assert.ok(!lines[0].includes("\n"), "the line has no newline in it");
  const line = JSON.parse(lines[0]);
  assert.equal(line.level, "error", "level");
  assert.equal(line.function, "example", "function");
  assert.equal(line.context, "reading a gateway", "context");
  assert.equal(line.message, INSIDE, "message");
  assert.ok(typeof line.stack === "string" && line.stack.includes(INSIDE), "the stack");
});

Deno.test("a database error's message and SQLSTATE are logged, and do not reach the body", async () => {
  const dbError = { message: INSIDE, code: "42P01", details: null, hint: null };
  const { result, lines } = capturing(() => serverError(request(), "example", dbError));
  const line = JSON.parse(lines[0]);
  assert.equal(line.message, INSIDE, "message");
  assert.equal(line.code, "42P01", "code");
  assert.ok(!(await result.text()).includes("gateway_secrets"), "the body leaks the database's message");
});
