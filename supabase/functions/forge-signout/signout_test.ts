import { DASHBOARD_SIGN_OUT, DOOR_SIGN_OUT, handler } from "./signout.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

const BASE = "http://gateway.test";
const DOOR_TOKEN = "door-session-token";
const SERVICE_KEY = "service-role-jwt";
const DASHBOARD = "https://app.site.test";

type Reply = { status: number; body: unknown } | "unreachable";
type Call = { method: string; path: string; scope: string | null; auth: string | null };

/** GoTrue behind the gateway: `/logout` answers `reply`, 204 by default. Every request is recorded. */
function gotrue(reply: Reply = { status: 204, body: null }) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    calls.push({ method: req.method, path: url.pathname, scope: url.searchParams.get("scope"), auth: req.headers.get("Authorization") });
    if (reply === "unreachable") return Promise.reject(new TypeError("connection refused"));
    return Promise.resolve(new Response(reply.body === null ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    }));
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

Deno.env.set("SUPABASE_URL", BASE);
Deno.env.set("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);

/** What the listener sends for Gitea's `GET /user/logout`: the path rewritten, the door's bearer kept. */
function click(token: string | null = DOOR_TOKEN): Request {
  return new Request(`${BASE}/forge-signout`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

/**
 * Runs one click with FRONTEND_PUBLIC_URL set to `dashboard` (unset for null). console.warn is
 * captured; console.log and console.error (auth-js logs a failed fetch) are silenced.
 */
async function run(request: Request, g: ReturnType<typeof gotrue>, dashboard: string | null = DASHBOARD) {
  const warned: string[] = [];
  const [originalWarn, originalLog, originalError] = [console.warn, console.log, console.error];
  console.warn = (...args: unknown[]) => warned.push(args.map(String).join(" "));
  console.log = console.error = () => {};
  if (dashboard === null) Deno.env.delete("FRONTEND_PUBLIC_URL");
  else Deno.env.set("FRONTEND_PUBLIC_URL", dashboard);
  try {
    const response = await handler(request);
    await response.body?.cancel();
    return { response, warned };
  } finally {
    [console.warn, console.log, console.error] = [originalWarn, originalLog, originalError];
    g.restore();
  }
}

Deno.test("ends the door's session alone, then sends the browser to the dashboard's sign-out", async () => {
  const g = gotrue();
  const { response, warned } = await run(click(), g);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), `${DASHBOARD}${DASHBOARD_SIGN_OUT}`);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(g.calls, [{ method: "POST", path: "/auth/v1/logout", scope: "local", auth: `Bearer ${DOOR_TOKEN}` }]);
  assert.equal(warned, []);
});

Deno.test("the dashboard's address is used with or without a trailing slash", async () => {
  for (const dashboard of [`${DASHBOARD}/`, `${DASHBOARD}//`, "http://app.localhost:3000"]) {
    const { response } = await run(click(), gotrue(), dashboard);
    assert.equal(response.headers.get("Location"), `${dashboard.replace(/\/+$/, "")}${DASHBOARD_SIGN_OUT}`, dashboard);
  }
});

Deno.test("with no usable token, nothing is ended and the browser still goes to the dashboard's sign-out", async () => {
  for (const request of [click(null), new Request(`${BASE}/forge-signout`, { headers: { Authorization: "Basic abc" } })]) {
    const g = gotrue();
    const { response } = await run(request, g);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), `${DASHBOARD}${DASHBOARD_SIGN_OUT}`);
    assert.equal(g.calls, [], "no request to GoTrue without a bearer");
  }
});

Deno.test("a session GoTrue no longer holds, or GoTrue not answering, still sends the browser on", async () => {
  const cases: [string, Reply][] = [
    ["session_not_found", { status: 403, body: { code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" } }],
    ["bad_jwt", { status: 401, body: { code: 401, error_code: "bad_jwt", msg: "invalid JWT" } }],
    ["unreachable", "unreachable"],
  ];
  for (const [name, reply] of cases) {
    const g = gotrue(reply);
    const { response, warned } = await run(click(), g);
    assert.equal(response.status, 302, name);
    assert.equal(response.headers.get("Location"), `${DASHBOARD}${DASHBOARD_SIGN_OUT}`, name);
    assert.equal(g.calls.map((c) => c.scope), ["local"], name);
    assert.equal(warned.some((w) => w.includes("could not end the door's session")), true, `${name}: warned`);
  }
});

Deno.test("without the dashboard's address, the door's own sign-out, with a warning", async () => {
  for (const dashboard of [null, "", "app.site.test", "javascript:alert(1)", "https://"]) {
    const g = gotrue();
    const { response, warned } = await run(click(), g, dashboard);
    assert.equal(response.status, 302, String(dashboard));
    assert.equal(response.headers.get("Location"), DOOR_SIGN_OUT, String(dashboard));
    assert.equal(g.calls.map((c) => c.scope), ["local"], `${dashboard}: the door's session still ends`);
    assert.equal(warned.some((w) => w.includes("FRONTEND_PUBLIC_URL")), true, `${dashboard}: warned`);
  }
});

Deno.test("a preflight is answered without ending anything", async () => {
  const g = gotrue();
  const { response } = await run(new Request(`${BASE}/forge-signout`, { method: "OPTIONS" }), g);
  assert.equal(response.status, 200);
  assert.equal(g.calls, []);
});
