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

/** What GoTrue answers for an account it has just made. */
const NEW_USER = { id: NEW_ID, email: "new@site.test", created_at: new Date().toISOString(), last_sign_in_at: null };
type Call = { method: string; path: string; query: string; body: Record<string, unknown> | null; auth: string | null };

/**
 * GoTrue and PostgREST behind the gateway, answered from `replies` keyed "METHOD /path"; a list
 * answers successive requests, its last entry repeating. The caller is an Administrator unless
 * `role` says otherwise. Every request is recorded in order.
 */
function stack(replies: Record<string, Reply | Reply[]> = {}, role = "Administrator") {
  const calls: Call[] = [];
  const defaults: Record<string, Reply> = {
    "GET /auth/v1/user": { status: 200, body: { id: ADMIN_ID, aud: "authenticated", email: "admin@site.test" } },
    "GET /rest/v1/user_roles": { status: 200, body: [{ roles: { name: role } }] },
    "POST /rest/v1/rpc/list_people": { status: 200, body: [{ user_id: ADMIN_ID, email: "admin@site.test" }] },
    "POST /auth/v1/admin/users": { status: 200, body: NEW_USER },
    "POST /auth/v1/invite": { status: 200, body: NEW_USER },
    "POST /rest/v1/rpc/record_person_added": { status: 204, body: null },
    "POST /rest/v1/rpc/remove_person_access": { status: 200, body: true },
    "POST /rest/v1/rpc/restore_person_access": { status: 200, body: "Operator" },
    "POST /rest/v1/rpc/record_person_password_set": { status: 204, body: null },
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
    const listed = replies[key];
    const given = Array.isArray(listed) ? (listed.length > 1 ? listed.shift() : listed[0]) : listed;
    const reply = given ?? defaults[key] ?? { status: 599, body: { message: `unexpected ${key}` } };
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

Deno.test("an address the site already holds is a conflict, and GoTrue is not asked", async () => {
  env(true);
  const s = stack({
    "POST /rest/v1/rpc/list_people": { status: 200, body: [{ user_id: TARGET_ID, email: "New@Site.test" }] },
  });
  const { response, body } = await run(post({ action: "add", email: "new@site.test", role: "Operator" }), s);
  assert.equal(response.status, 409);
  assert.ok(/already exists/.test(body.details));
  assert.equal(gotrueAdmin(s.paths()), []);
});

Deno.test("an account GoTrue did not just make is never deleted", async () => {
  env(true);
  const s = stack({
    "POST /auth/v1/invite": {
      status: 200,
      body: { id: NEW_ID, email: "new@site.test", created_at: "2026-01-01T00:00:00Z", last_sign_in_at: null },
    },
    "POST /rest/v1/rpc/record_person_added": {
      status: 400,
      body: { code: "22023", message: "not an account added in the last hour", details: null, hint: null },
    },
  });
  const { response } = await run(post({ action: "add", email: "new@site.test", role: "Operator" }), s);
  assert.equal(response.status, 500);
  assert.equal(s.paths().some((p) => p.startsWith("DELETE")), false);
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

const RECORD_PATH = "/rest/v1/rpc/record_person_password_set";

Deno.test("setting a password asks the database, changes it in GoTrue, then records it", async () => {
  // With a relay as well: a new password is always minted and shown, never mailed.
  for (const smtp of [false, true]) {
    env(smtp);
    const s = stack();
    const { response, body, logged } = await run(post({ action: "set-password", user_id: TARGET_ID }), s);
    assert.equal(response.status, 200, `relay ${smtp}`);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(s.paths().slice(2), [
      `POST ${RECORD_PATH}`,
      `PUT /auth/v1/admin/users/${TARGET_ID}`,
      `POST ${RECORD_PATH}`,
    ]);

    const [check, record] = s.calls.filter((c) => c.path === RECORD_PATH);
    assert.equal(check.body, { p_user_id: TARGET_ID, p_check_only: true });
    assert.equal(record.body, { p_user_id: TARGET_ID, p_check_only: false });
    assert.equal(check.auth, `Bearer ${CALLER_TOKEN}`, "decided as the caller");
    assert.equal(record.auth, `Bearer ${CALLER_TOKEN}`, "recorded as the caller");

    const change = s.calls.find((c) => c.method === "PUT")!;
    assert.equal(change.auth, `Bearer ${SERVICE_KEY}`, "the admin call carries the secret key");
    assert.equal(Object.keys(change.body ?? {}), ["password"], "only the password changes");
    assert.ok(PASSWORD_SHAPE.test(String(change.body?.password)));
    assert.equal(body, { user_id: TARGET_ID, password: change.body?.password });
    assert.ok(!JSON.stringify([check.body, record.body]).includes(body.password), "the password never reaches the database");
    assert.ok(!logged.join("\n").includes(body.password), "nor the log");
  }
});

Deno.test("nobody sets their own password here, and nothing is called", async () => {
  env(false);
  const s = stack();
  const { response, body } = await run(post({ action: "set-password", user_id: ADMIN_ID }), s);
  assert.equal(response.status, 403);
  assert.ok(/Change Password/.test(body.details), "points at the account menu");
  assert.equal(s.paths(), ["GET /auth/v1/user", "GET /rest/v1/user_roles"]);
});

Deno.test("a caller who is not an Administrator sets no password", async () => {
  for (const role of ["Shopfloor_Manager", "Operator", "Auditor"]) {
    env(false);
    const s = stack({}, role);
    const { response } = await run(post({ action: "set-password", user_id: TARGET_ID }), s);
    assert.equal(response.status, 403, role);
    assert.equal(s.paths(), ["GET /auth/v1/user", "GET /rest/v1/user_roles"], role);
  }
});

Deno.test("a password the database refuses never reaches GoTrue", async () => {
  const refusals: [number, string, string, number][] = [
    [403, "42501", "insufficient privileges to set a person's password", 403],
    [404, "P0002", `person ${TARGET_ID} not found`, 404],
    [400, "22023", `${TARGET_ID} is a machine identity, not a person.`, 400],
    [400, "P0001", "this person's access is removed. Restore it first, then set a new password.", 409],
  ];
  for (const [status, code, message, expected] of refusals) {
    env(false);
    const s = stack({ [`POST ${RECORD_PATH}`]: { status, body: { code, message, details: null, hint: null } } });
    const { response, body } = await run(post({ action: "set-password", user_id: TARGET_ID }), s);
    assert.equal(response.status, expected, code);
    assert.equal(body.details, message, code);
    assert.equal("password" in body, false, code);
    assert.equal(gotrueAdmin(s.paths()), [], code);
    assert.equal(s.paths().filter((p) => p.endsWith(RECORD_PATH)).length, 1, `${code}: nothing recorded`);
  }
});

Deno.test("a password GoTrue did not change is not recorded", async () => {
  env(false);
  const s = stack({ [`PUT /auth/v1/admin/users/${TARGET_ID}`]: { status: 500, body: { code: 500, msg: "boom" } } });
  const { response, body } = await run(post({ action: "set-password", user_id: TARGET_ID }), s);
  assert.equal(response.status, 502);
  assert.equal("password" in body, false);
  assert.equal(s.paths().filter((p) => p.endsWith(RECORD_PATH)).length, 1, "only the check ran");
});

Deno.test("a change the database did not record says so, and withholds the password", async () => {
  env(false);
  const s = stack({
    [`POST ${RECORD_PATH}`]: [
      { status: 204, body: null },
      { status: 503, body: { code: "57P01", message: "terminating connection", details: null, hint: null } },
    ],
  });
  const { response, body, logged } = await run(post({ action: "set-password", user_id: TARGET_ID }), s);
  assert.equal(response.status, 500);
  assert.ok(/new password/.test(body.details) && /Set New Password again/.test(body.details), body.details);
  assert.equal("password" in body, false);
  const password = String(s.calls.find((c) => c.method === "PUT")?.body?.password);
  assert.ok(!logged.join("\n").includes(password), "the password is not logged");
  assert.ok(!JSON.stringify(body).includes(password));
});
