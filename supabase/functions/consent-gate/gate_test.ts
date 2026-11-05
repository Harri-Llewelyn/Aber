import { authorizationIdOf, decide, GRAFANA_CLIENT_ID, handler } from "./gate.ts";
import { MFA_REFUSAL } from "../_shared/secondFactor.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

const BASE = "http://gateway.test";
const USER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const NODE_RED = "c0ffee00-0000-4000-8000-000000000002";
const AUTHORIZATION = "abc123DEF";

const base64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const token = (claims: Record<string, unknown>) =>
  `${base64url({ alg: "ES256", typ: "JWT" })}.${base64url({ sub: USER_ID, ...claims })}.signature`;

type Reply = { status: number; body: unknown } | "unreachable";

/**
 * GoTrue and PostgREST behind the gateway, answered from `replies` keyed "METHOD /path"; by default
 * the caller is a signed-in Administrator, the switch is on and the authorization is Node-RED's.
 */
function stack(replies: Record<string, Reply> = {}) {
  const calls: string[] = [];
  const defaults: Record<string, Reply> = {
    "GET /auth/v1/user": { status: 200, body: { id: USER_ID, aud: "authenticated", email: "admin@site.test" } },
    "GET /rest/v1/user_roles": { status: 200, body: [{ roles: { name: "Administrator" } }] },
    "GET /rest/v1/system_settings": { status: 200, body: [{ value: true }] },
    "POST /rest/v1/rpc/oauth_authorization_client": { status: 200, body: NODE_RED },
  };
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const key = `${req.method} ${new URL(req.url).pathname}`;
    calls.push(key);
    const reply = replies[key] ?? defaults[key] ?? { status: 599, body: { message: `unexpected ${key}` } };
    if (reply === "unreachable") return Promise.reject(new TypeError("connection refused"));
    return Promise.resolve(new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    }));
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

Deno.env.set("SUPABASE_URL", BASE);
Deno.env.set("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-jwt");

/** What the listener sends: the original method and path under /consent-gate, and the bearer. */
function check(claims: Record<string, unknown> | null, { method = "GET", suffix = "" } = {}): Request {
  return new Request(`${BASE}/consent-gate/auth/v1/oauth/authorizations/${AUTHORIZATION}${suffix}`, {
    method,
    headers: claims ? { Authorization: `Bearer ${token(claims)}` } : {},
  });
}

async function run(request: Request, s: ReturnType<typeof stack>) {
  const [originalError, originalWarn] = [console.error, console.warn];
  const logged: string[] = [];
  console.error = console.warn = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const response = await handler(request);
    return { status: response.status, body: await response.json(), logged };
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    s.restore();
  }
}

Deno.test("the authorization id is the segment after authorizations/", () => {
  assert.equal(authorizationIdOf(`/consent-gate/auth/v1/oauth/authorizations/${AUTHORIZATION}`), AUTHORIZATION);
  assert.equal(authorizationIdOf(`/consent-gate/auth/v1/oauth/authorizations/${AUTHORIZATION}/consent`), AUTHORIZATION);
  assert.equal(authorizationIdOf("/consent-gate/auth/v1/oauth/authorizations/"), null);
  assert.equal(authorizationIdOf("/consent-gate/auth/v1/oauth/authorizations//consent"), null);
});

Deno.test("the decision table", async () => {
  const facts = (role: string | null, claims: Record<string, unknown>, on: boolean, client: string | null) => ({
    role,
    claims,
    switchOn: () => Promise.resolve(on),
    clientId: () => Promise.resolve(client),
  });
  const rows: [string, ReturnType<typeof facts>, boolean][] = [
    ["Administrator, aal1, switch on, Node-RED", facts("Administrator", { aal: "aal1" }, true, NODE_RED), false],
    ["Shopfloor Manager, aal1, switch on, Node-RED", facts("Shopfloor_Manager", { aal: "aal1" }, true, NODE_RED), false],
    ["Administrator, aal1, switch on, an unknown authorization", facts("Administrator", { aal: "aal1" }, true, null), false],
    ["Administrator, aal1, switch on, Grafana", facts("Administrator", { aal: "aal1" }, true, GRAFANA_CLIENT_ID), true],
    ["Administrator, aal2, switch on, Node-RED", facts("Administrator", { aal: "aal2" }, true, NODE_RED), true],
    ["Administrator, federated, switch on, Node-RED", facts("Administrator", { aal: "aal1", amr: [{ method: "sso/saml" }] }, true, NODE_RED), true],
    ["Administrator, aal1, switch off, Node-RED", facts("Administrator", { aal: "aal1" }, false, NODE_RED), true],
    ["Operator, aal1, switch on, Node-RED", facts("Operator", { aal: "aal1" }, true, NODE_RED), true],
    ["Auditor, aal1, switch on, Node-RED", facts("Auditor", { aal: "aal1" }, true, NODE_RED), true],
    ["no role, aal1, switch on, Node-RED", facts(null, { aal: "aal1" }, true, NODE_RED), true],
  ];
  for (const [label, f, admit] of rows) {
    assert.equal((await decide(f)).admit, admit, label);
  }
});

Deno.test("the switch and the app are read only when the decision needs them", async () => {
  const asked: string[] = [];
  const f = (role: string, claims: Record<string, unknown>, on: boolean) => ({
    role,
    claims,
    switchOn: () => { asked.push("switch"); return Promise.resolve(on); },
    clientId: () => { asked.push("client"); return Promise.resolve(NODE_RED); },
  });
  await decide(f("Operator", { aal: "aal1" }, true));
  await decide(f("Administrator", { aal: "aal2" }, true));
  assert.equal(asked, []);
  await decide(f("Administrator", { aal: "aal1" }, false));
  assert.equal(asked, ["switch"]);
});

Deno.test("an aal1 Administrator is refused on both calls, in GoTrue's shape", async () => {
  for (const [method, suffix] of [["GET", ""], ["POST", "/consent"]]) {
    const s = stack();
    const { status, body } = await run(check({ aal: "aal1" }, { method, suffix }), s);
    assert.equal(status, 403, `${method} ${suffix}`);
    assert.equal(body, { code: 403, error_code: "mfa_required", msg: MFA_REFUSAL });
    assert.equal(s.calls.includes("POST /rest/v1/rpc/oauth_authorization_client"), true, "the app was read");
  }
});

Deno.test("Grafana's sign-in, an aal2 session, an uncovered role and a switch that is off pass", async () => {
  const cases: [string, Record<string, unknown>, Record<string, Reply>][] = [
    ["Grafana", { aal: "aal1" }, { "POST /rest/v1/rpc/oauth_authorization_client": { status: 200, body: GRAFANA_CLIENT_ID } }],
    ["aal2", { aal: "aal2" }, {}],
    ["an Operator", { aal: "aal1" }, { "GET /rest/v1/user_roles": { status: 200, body: [{ roles: { name: "Operator" } }] } }],
    ["no role", { aal: "aal1" }, { "GET /rest/v1/user_roles": { status: 200, body: [] } }],
    ["the switch off", { aal: "aal1" }, { "GET /rest/v1/system_settings": { status: 200, body: [{ value: false }] } }],
  ];
  for (const [label, claims, replies] of cases) {
    const { status } = await run(check(claims), stack(replies));
    assert.equal(status, 200, label);
  }
});

Deno.test("no bearer is 401, a session GoTrue refuses 401, and anything unread 503", async () => {
  assert.equal((await run(check(null), stack())).status, 401, "no bearer");
  assert.equal((await run(check({ aal: "aal1" }), stack({ "GET /auth/v1/user": { status: 401, body: { msg: "bad" } } }))).status,
    401, "a refused session");
  const failures: [string, Record<string, Reply>][] = [
    ["GoTrue", { "GET /auth/v1/user": "unreachable" }],
    ["the role", { "GET /rest/v1/user_roles": { status: 500, body: { message: "down" } } }],
    ["the switch", { "GET /rest/v1/system_settings": { status: 500, body: { message: "down" } } }],
    ["the app", { "POST /rest/v1/rpc/oauth_authorization_client": { status: 500, body: { message: "down" } } }],
  ];
  for (const [label, replies] of failures) {
    const { status, body } = await run(check({ aal: "aal1" }), stack(replies));
    assert.equal(status, 503, label);
    assert.equal(body.error_code, "consent_check_unavailable", label);
  }
});
