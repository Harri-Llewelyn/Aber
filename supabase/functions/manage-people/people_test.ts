import { BAN_DURATION, handler, initialPassword } from "./people.ts";

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
const CALLER_TOKEN = "caller-session-token";
const SERVICE_KEY = "service-role-jwt";
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const TARGET_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const NEW_ID = "cccccccc-0000-4000-8000-000000000003";
const PASSWORD_SHAPE = /^[2-9a-hjkmnp-z]{6}(-[2-9a-hjkmnp-z]{6}){3}$/;

type Reply = { status: number; body: unknown };
type Call = { method: string; path: string; query: string; body: Record<string, unknown> | null; auth: string | null };

/**
 * GoTrue and PostgREST behind the gateway, answered from `replies` keyed "METHOD /path". The caller
 * is an Administrator unless `role` says otherwise. Every request is recorded in order.
 */
function stack(replies: Record<string, Reply> = {}, role = "Administrator") {
  const calls: Call[] = [];
  const defaults: Record<string, Reply> = {
    "GET /auth/v1/user": { status: 200, body: { id: ADMIN_ID, aud: "authenticated", email: "admin@site.test" } },
    "GET /rest/v1/user_roles": { status: 200, body: [{ roles: { name: role } }] },
    "POST /auth/v1/admin/users": { status: 200, body: { id: NEW_ID, email: "new@site.test" } },
    "POST /auth/v1/invite": { status: 200, body: { id: NEW_ID, email: "new@site.test" } },
    "POST /rest/v1/rpc/record_person_added": { status: 204, body: null },
    "POST /rest/v1/rpc/remove_person_access": { status: 200, body: true },
    "POST /rest/v1/rpc/restore_person_access": { status: 200, body: "Operator" },
    [`PUT /auth/v1/admin/users/${TARGET_ID}`]: { status: 200, body: { id: TARGET_ID } },
    [`DELETE /auth/v1/admin/users/${NEW_ID}`]: { status: 200, body: {} },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const text = await req.text();
    calls.push({
      method: req.method,
      path: url.pathname,
      query: url.search,
      body: text ? JSON.parse(text) : null,
      auth: req.headers.get("Authorization"),
    });
    const key = `${req.method} ${url.pathname}`;
    const reply = replies[key] ?? defaults[key] ?? { status: 599, body: { message: `unexpected ${key}` } };
    return new Response(reply.body === null ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    calls,
    paths: () => calls.map((c) => `${c.method} ${c.path}`),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function env(smtp: boolean) {
  Deno.env.set("SUPABASE_URL", BASE);
  Deno.env.set("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
  Deno.env.set("AUTH_SMTP_CONFIGURED", smtp ? "true" : "false");
  Deno.env.set("AUTH_INVITE_REDIRECT_URL", "https://dashboard.site.test/reset-password");
}

function post(body: unknown, token: string | null = CALLER_TOKEN): Request {
  return new Request(`${BASE}/manage-people`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

/** Runs one request against a stubbed stack with console.error captured, so a test can assert
 *  what was logged. */
async function run(request: Request, s: ReturnType<typeof stack>) {
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const response = await handler(request);
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null, logged };
  } finally {
    console.error = originalError;
    s.restore();
  }
}

const gotrueAdmin = (paths: string[]) =>
  paths.filter((p) => p.includes("/auth/v1/admin/") || p.endsWith("/auth/v1/invite"));

Deno.test("the initial password has setup's shape and is new each time", () => {
  const passwords = new Set(Array.from({ length: 50 }, () => initialPassword()));
  for (const p of passwords) assert.ok(PASSWORD_SHAPE.test(p), `bad shape: ${p}`);
  assert.equal(passwords.size, 50);
});

Deno.test("anything but POST is refused, and a preflight is answered", async () => {
  env(false);
  assert.equal((await handler(new Request(`${BASE}/manage-people`, { method: "OPTIONS" }))).status, 200);
  const get = await handler(new Request(`${BASE}/manage-people`));
  assert.equal(get.status, 405);
  await get.body?.cancel();
});

Deno.test("no session is refused before anything is called", async () => {
  env(false);
  const s = stack();
  const { response } = await run(post({ action: "add", email: "new@site.test", role: "Operator" }, null), s);
  assert.equal(response.status, 401);
  assert.equal(s.calls.length, 0);
});

Deno.test("a caller who is not an Administrator reaches no admin call", async () => {
  for (const role of ["Shopfloor_Manager", "Operator", "Auditor"]) {
    env(false);
    const s = stack({}, role);
    const { response } = await run(post({ action: "remove", user_id: TARGET_ID }), s);
    assert.equal(response.status, 403, role);
    assert.equal(s.paths(), ["GET /auth/v1/user", "GET /rest/v1/user_roles"], role);
  }
});

Deno.test("a token GoTrue rejects is refused", async () => {
  env(false);
  const s = stack({ "GET /auth/v1/user": { status: 401, body: { code: 401, msg: "invalid JWT" } } });
  const { response } = await run(post({ action: "add", email: "new@site.test", role: "Operator" }), s);
  assert.equal(response.status, 401);
  assert.equal(gotrueAdmin(s.paths()), []);
});

Deno.test("without a mail relay, a person is created with a password shown once", async () => {
  env(false);
  const s = stack();
  const { response, body, logged } = await run(post({ action: "add", email: " New@Site.test ", role: "Operator" }), s);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  const create = s.calls.find((c) => c.path === "/auth/v1/admin/users")!;
  assert.equal(create.auth, `Bearer ${SERVICE_KEY}`, "the admin call carries the secret key");
  assert.equal(create.body?.email, "new@site.test");
  assert.equal(create.body?.email_confirm, true);
  assert.ok(PASSWORD_SHAPE.test(String(create.body?.password)));
  assert.equal(body.password, create.body?.password, "the password GoTrue was given is the one shown");
  assert.equal(body.invited, false);

  const record = s.calls.find((c) => c.path === "/rest/v1/rpc/record_person_added")!;
  assert.equal(record.auth, `Bearer ${CALLER_TOKEN}`, "recorded as the caller");
  assert.equal(record.body, { p_user_id: NEW_ID, p_role: "Operator", p_invited: false });
  assert.ok(!JSON.stringify(record.body).includes(body.password), "the password never reaches the database");
  assert.ok(!logged.join("\n").includes(body.password), "nor the log");
  assert.equal(s.paths().includes("POST /auth/v1/invite"), false);
});

Deno.test("with a mail relay, a person is invited and no password exists", async () => {
  env(true);
  const s = stack();
  const { response, body } = await run(post({ action: "add", email: "new@site.test", role: "Auditor" }), s);
  assert.equal(response.status, 200);
  assert.equal(body.invited, true);
  assert.equal("password" in body, false);
  const invite = s.calls.find((c) => c.path === "/auth/v1/invite")!;
  assert.equal(invite.body?.email, "new@site.test");
  assert.ok(invite.query.includes(encodeURIComponent("https://dashboard.site.test/reset-password")),
    "the link lands on the form that sets a password");
  assert.equal(s.paths().includes("POST /auth/v1/admin/users"), false);
  assert.equal(s.calls.find((c) => c.path === "/rest/v1/rpc/record_person_added")?.body?.p_invited, true);
});

Deno.test("an unknown role or a malformed address is refused before GoTrue", async () => {
  for (const body of [
    { action: "add", email: "new@site.test", role: "Superuser" },
    { action: "add", email: "not-an-address", role: "Operator" },
    { action: "promote", user_id: TARGET_ID },
  ]) {
    env(false);
    const s = stack();
    const { response } = await run(post(body), s);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(gotrueAdmin(s.paths()), []);
  }
});

Deno.test("an address already in use is a conflict", async () => {
  env(false);
  const s = stack({
    "POST /auth/v1/admin/users": {
      status: 422,
      body: { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" },
    },
  });
  const { response, body } = await run(post({ action: "add", email: "new@site.test", role: "Operator" }), s);
  assert.equal(response.status, 409);
  assert.ok(/already exists/.test(body.details));
  assert.equal(s.paths().includes("POST /rest/v1/rpc/record_person_added"), false);
});

Deno.test("an account the database would not record is deleted again, and its password withheld", async () => {
  env(false);
  const s = stack({
    "POST /rest/v1/rpc/record_person_added": {
      status: 403,
      body: { code: "42501", message: "insufficient privileges to add a person", details: null, hint: null },
    },
  });
  const { response, body, logged } = await run(post({ action: "add", email: "new@site.test", role: "Operator" }), s);
  assert.equal(response.status, 403);
  assert.equal("password" in body, false);
  assert.ok(s.paths().includes(`DELETE /auth/v1/admin/users/${NEW_ID}`), "the account is deleted");
  const password = String(s.calls.find((c) => c.path === "/auth/v1/admin/users")?.body?.password);
  assert.ok(!logged.join("\n").includes(password), "the password is not logged");
});

Deno.test("removing access asks the database first, then bans and never deletes", async () => {
  env(false);
  const s = stack();
  const { response, body } = await run(post({ action: "remove", user_id: TARGET_ID }), s);
  assert.equal(response.status, 200);
  assert.equal(body.access, "removed");
  assert.equal(s.paths().slice(2), [
    "POST /rest/v1/rpc/remove_person_access",
    `PUT /auth/v1/admin/users/${TARGET_ID}`,
  ]);
  const ban = s.calls.find((c) => c.method === "PUT")!;
  assert.equal(ban.body, { ban_duration: BAN_DURATION });
  assert.equal(ban.auth, `Bearer ${SERVICE_KEY}`);
  assert.equal(s.calls.find((c) => c.path === "/rest/v1/rpc/remove_person_access")?.auth, `Bearer ${CALLER_TOKEN}`);
  assert.equal(s.paths().some((p) => p.startsWith("DELETE")), false);
});

Deno.test("a removal the database refuses never reaches GoTrue", async () => {
  env(false);
  const s = stack({
    "POST /rest/v1/rpc/remove_person_access": {
      status: 400,
      body: { code: "P0001", message: "this would leave no Administrator who can sign in.", details: null, hint: null },
    },
  });
  const { response, body } = await run(post({ action: "remove", user_id: TARGET_ID }), s);
  assert.equal(response.status, 409);
  assert.ok(/no Administrator/.test(body.details));
  assert.equal(gotrueAdmin(s.paths()), []);
});

Deno.test("nobody removes or restores their own access", async () => {
  for (const action of ["remove", "restore"]) {
    env(false);
    const s = stack();
    const { response } = await run(post({ action, user_id: ADMIN_ID }), s);
    assert.equal(response.status, 403, action);
    assert.equal(s.paths(), ["GET /auth/v1/user", "GET /rest/v1/user_roles"], action);
  }
});

Deno.test("an unknown person is a 404", async () => {
  env(false);
  const s = stack({
    "POST /rest/v1/rpc/remove_person_access": {
      status: 404,
      body: { code: "P0002", message: `person ${TARGET_ID} not found`, details: null, hint: null },
    },
  });
  const { response } = await run(post({ action: "remove", user_id: TARGET_ID }), s);
  assert.equal(response.status, 404);
  assert.equal(gotrueAdmin(s.paths()), []);
});

Deno.test("a ban GoTrue did not make says to remove access again", async () => {
  env(false);
  const s = stack({ [`PUT /auth/v1/admin/users/${TARGET_ID}`]: { status: 500, body: { code: 500, msg: "boom" } } });
  const { response, body } = await run(post({ action: "remove", user_id: TARGET_ID }), s);
  assert.equal(response.status, 502);
  assert.ok(/Remove access again/.test(body.details));
});

Deno.test("restoring access gives the role back, then lifts the ban", async () => {
  env(false);
  const s = stack();
  const { response, body } = await run(post({ action: "restore", user_id: TARGET_ID }), s);
  assert.equal(response.status, 200);
  assert.equal(body, { user_id: TARGET_ID, access: "active", role: "Operator" });
  assert.equal(s.paths().slice(2), [
    "POST /rest/v1/rpc/restore_person_access",
    `PUT /auth/v1/admin/users/${TARGET_ID}`,
  ]);
  assert.equal(s.calls.find((c) => c.method === "PUT")?.body, { ban_duration: "none" });
});
