import { handler, SIGNOUT_PATH } from "./admission.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

const BASE = "http://gateway.test";
const CALLER_TOKEN = "caller-session-token";
const SERVICE_KEY = "service-role-jwt";
const USER_ID = "aaaaaaaa-0000-4000-8000-000000000001";

type Reply = { status: number; body: unknown } | "unreachable";
type Call = { method: string; path: string; auth: string | null };

/**
 * GoTrue and PostgREST behind the gateway, answered from `replies` keyed "METHOD /path"; the caller
 * is a signed-in Administrator unless a reply says otherwise. "unreachable" makes fetch throw.
 */
function stack(replies: Record<string, Reply> = {}) {
  const calls: Call[] = [];
  const defaults: Record<string, Reply> = {
    "GET /auth/v1/user": { status: 200, body: { id: USER_ID, aud: "authenticated", email: "admin@site.test" } },
    "GET /rest/v1/user_roles": { status: 200, body: [{ roles: { name: "Administrator" } }] },
  };
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    calls.push({ method: req.method, path: url.pathname, auth: req.headers.get("Authorization") });
    const key = `${req.method} ${url.pathname}`;
    const reply = replies[key] ?? defaults[key] ?? { status: 599, body: { message: `unexpected ${key}` } };
    if (reply === "unreachable") return Promise.reject(new TypeError("connection refused"));
    return Promise.resolve(new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    }));
  };
  return {
    calls,
    paths: () => calls.map((c) => `${c.method} ${c.path}`),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

Deno.env.set("SUPABASE_URL", BASE);
Deno.env.set("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);

/** What the listener sends: the original method and path under /studio-admission, and the bearer. */
function check(method = "GET", token: string | null = CALLER_TOKEN): Request {
  return new Request(`${BASE}/studio-admission/api/platform/pg-meta/default/query`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

/** Runs one check against a stubbed stack, with console.error and console.warn captured. */
async function run(request: Request, s: ReturnType<typeof stack>) {
  const logged: string[] = [];
  const [originalError, originalWarn] = [console.error, console.warn];
  console.error = console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const response = await handler(request);
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null, logged };
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    s.restore();
  }
}

const SESSION = "GET /auth/v1/user";
const ROLE = "GET /rest/v1/user_roles";

Deno.test("an Administrator is admitted, after GoTrue and user_roles are both asked", async () => {
  for (const method of ["GET", "POST", "DELETE"]) {
    const s = stack();
    const { response, body } = await run(check(method), s);
    assert.equal(response.status, 200, method);
    assert.equal(body, { sub: USER_ID, role: "Administrator" }, method);
    assert.equal(s.paths(), [SESSION, ROLE], method);
    assert.equal(s.calls[0].auth, `Bearer ${CALLER_TOKEN}`, "the session check is the caller's own");
    assert.equal(s.calls[1].auth, `Bearer ${SERVICE_KEY}`, "the role lookup is the service key's");
  }
});

Deno.test("any other role, or none, is refused with 403", async () => {
  for (const rows of [[{ roles: { name: "Shopfloor_Manager" } }], [{ roles: { name: "Operator" } }], []]) {
    const s = stack({ [ROLE]: { status: 200, body: rows } });
    const { response, body } = await run(check(), s);
    assert.equal(response.status, 403, JSON.stringify(rows));
    assert.equal(body.error.endsWith("does not open Studio"), true, body.error);
  }
});

Deno.test("a session GoTrue refuses is sent through the door's sign-out, and no role is read", async () => {
  for (const refusal of [
    { status: 403, body: { code: 403, error_code: "user_banned", msg: "User is banned" } },
    { status: 403, body: { code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" } },
    { status: 401, body: { code: 401, error_code: "bad_jwt", msg: "invalid JWT" } },
  ]) {
    const s = stack({ [SESSION]: refusal });
    const { response } = await run(check(), s);
    assert.equal(response.status, 302, refusal.body.error_code);
    assert.equal(response.headers.get("Location"), SIGNOUT_PATH, refusal.body.error_code);
    assert.equal(s.paths(), [SESSION], refusal.body.error_code);
  }
});

Deno.test("GoTrue or the role lookup not answering is a 503 that names no cause", async () => {
  const cases: [string, Record<string, Reply>, string[]][] = [
    ["GoTrue unreachable", { [SESSION]: "unreachable" }, [SESSION]],
    ["GoTrue 503", { [SESSION]: { status: 503, body: { msg: "upstream connect error" } } }, [SESSION]],
    ["PostgREST 500", { [ROLE]: { status: 500, body: { message: "permission denied for table user_roles" } } }, [SESSION, ROLE]],
  ];
  for (const [name, replies, paths] of cases) {
    const s = stack(replies);
    const { response, body, logged } = await run(check(), s);
    assert.equal(response.status, 503, name);
    assert.equal(typeof body.request_id, "string", name);
    assert.equal(JSON.stringify(body).includes("permission denied"), false, `${name}: the cause stays in the log`);
    assert.equal(logged.length > 0, true, `${name}: logged`);
    assert.equal(s.paths(), paths, name);
  }
});

Deno.test("no bearer is a 401, before anything is asked", async () => {
  const s = stack();
  const { response } = await run(check("GET", null), s);
  assert.equal(response.status, 401);
  assert.equal(s.paths(), []);
});
