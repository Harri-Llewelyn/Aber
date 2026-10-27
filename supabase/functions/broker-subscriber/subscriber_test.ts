import { DESCRIPTION_MAX, handler, NAME_MAX, purposeProblem, SUBSCRIBER_USERNAME } from "./subscriber.ts";

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
const CREDENTIAL = "http://credential.test:9010";
const CREDENTIAL_TOKEN = "credential-service-bearer-token-0001";
const CALLER_TOKEN = "caller-session-token";
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const USERNAME = "sub0a1b2c3d4e5f60718293a";
const PASSWORD = "Zm9yLXRoZS10ZXN0LW9ubHktMDAwMDAw";
const PURPOSE = { name: "Line 4 OEE board", description: "The contractor dashboard on line 4. Reads only." };

type Reply = { status: number; body: unknown };
type Call = { method: string; host: string; path: string; body: Record<string, unknown> | null; auth: string | null };

/**
 * GoTrue, PostgREST and the credential service, answered from `replies` keyed "METHOD /path". The
 * caller is an Administrator unless `role` says otherwise. Every request is recorded in order.
 */
function stack(replies: Record<string, Reply> = {}, role = "Administrator") {
  const calls: Call[] = [];
  const defaults: Record<string, Reply> = {
    "GET /auth/v1/user": { status: 200, body: { id: ADMIN_ID, aud: "authenticated", email: "admin@site.test" } },
    "GET /rest/v1/user_roles": { status: 200, body: [{ roles: { name: role } }] },
    "POST /subscribers": {
      status: 200,
      body: { username: USERNAME, password: PASSWORD, name: PURPOSE.name, description: PURPOSE.description, roles: ["subscriber"] },
    },
    "POST /subscriber-deletions": {
      status: 200,
      body: { username: USERNAME, existed: true, deleted: true, name: PURPOSE.name, description: PURPOSE.description, roles: ["subscriber"] },
    },
    "POST /rest/v1/rpc/record_broker_account_created": { status: 200, body: 41 },
    "POST /rest/v1/rpc/record_broker_account_deleted": { status: 200, body: 42 },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const text = await req.text();
    calls.push({
      method: req.method,
      host: url.host,
      path: url.pathname,
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
    toCredentialService: () => calls.filter((c) => c.host === new URL(CREDENTIAL).host),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function env() {
  Deno.env.set("SUPABASE_URL", BASE);
  Deno.env.set("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  Deno.env.set("MQTT_CREDENTIAL_SERVICE_URL", `${CREDENTIAL}/`);
  Deno.env.set("MQTT_CREDENTIAL_SERVICE_TOKEN", CREDENTIAL_TOKEN);
}

function post(body: unknown, token: string | null = CALLER_TOKEN): Request {
  return new Request(`${BASE}/broker-subscriber`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

/** Runs one request against a stubbed stack with console.error captured. */
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

Deno.test("anything but POST is refused, and a preflight is answered", async () => {
  env();
  assert.equal((await handler(new Request(`${BASE}/broker-subscriber`, { method: "OPTIONS" }))).status, 200);
  const get = await handler(new Request(`${BASE}/broker-subscriber`));
  assert.equal(get.status, 405);
  await get.body?.cancel();
});

Deno.test("a deployment without the credential service names what it lacks", async () => {
  env();
  Deno.env.delete("MQTT_CREDENTIAL_SERVICE_TOKEN");
  const s = stack();
  const { response, body } = await run(post({ action: "create", ...PURPOSE }), s);
  assert.equal(response.status, 500);
  assert.ok(String(body.details).includes("MQTT_CREDENTIAL_SERVICE_TOKEN"));
  assert.equal(s.calls.length, 0);
});

Deno.test("no session is refused before anything is called", async () => {
  env();
  const s = stack();
  const { response } = await run(post({ action: "create", ...PURPOSE }, null), s);
  assert.equal(response.status, 401);
  assert.equal(s.calls.length, 0);
});

Deno.test("a caller who is not an Administrator reaches neither the credential service nor the record", async () => {
  for (const role of ["Shopfloor_Manager", "Operator", "Auditor"]) {
    for (const action of [{ action: "create", ...PURPOSE }, { action: "delete", username: USERNAME }]) {
      env();
      const s = stack({}, role);
      const { response } = await run(post(action), s);
      assert.equal(response.status, 403, `${role} ${action.action}`);
      assert.equal(s.paths(), ["GET /auth/v1/user", "GET /rest/v1/user_roles"], `${role} ${action.action}`);
    }
  }
});

Deno.test("a caller with no role is refused as a non-Administrator is", async () => {
  env();
  const s = stack({ "GET /rest/v1/user_roles": { status: 200, body: [] } });
  const { response } = await run(post({ action: "create", ...PURPOSE }), s);
  assert.equal(response.status, 403);
  assert.equal(s.toCredentialService(), []);
});

Deno.test("a token GoTrue rejects is refused", async () => {
  env();
  const s = stack({ "GET /auth/v1/user": { status: 401, body: { code: 401, msg: "invalid JWT" } } });
  const { response } = await run(post({ action: "create", ...PURPOSE }), s);
  assert.equal(response.status, 401);
  assert.equal(s.toCredentialService(), []);
});

Deno.test("an unknown action and a body that is not an object are refused", async () => {
  for (const body of [{ action: "grant", role: "admin" }, { ...PURPOSE }, ["create"]]) {
    env();
    const s = stack();
    const { response } = await run(post(body), s);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(s.toCredentialService(), []);
  }
});

Deno.test("a missing or malformed purpose is refused before the credential service is asked", async () => {
  for (const purpose of [
    { description: PURPOSE.description },
    { name: "   ", description: PURPOSE.description },
    { name: PURPOSE.name },
    { name: PURPOSE.name, description: "" },
    { name: PURPOSE.name, description: 42 },
    { name: "two\nlines", description: PURPOSE.description },
    { name: "x".repeat(NAME_MAX + 1), description: PURPOSE.description },
    { name: PURPOSE.name, description: "x".repeat(DESCRIPTION_MAX + 1) },
  ]) {
    env();
    const s = stack();
    const { response, body } = await run(post({ action: "create", ...purpose }), s);
    assert.equal(response.status, 400, JSON.stringify(purpose));
    assert.ok(/name|description/.test(body.details), body.details);
    assert.equal(s.toCredentialService(), [], JSON.stringify(purpose));
  }
});

Deno.test("an Administrator creates an account: the password once, the record as the caller", async () => {
  env();
  const s = stack();
  const { response, body, logged } = await run(
    post({ action: "create", name: `  ${PURPOSE.name} `, description: PURPOSE.description, role: "admin", username: "gwy120000000000400080000" }),
    s,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(body, {
    mqtt_username: USERNAME, password: PASSWORD, name: PURPOSE.name, description: PURPOSE.description,
    role: "subscriber", audit_recorded: true,
  });

  // The service is given the purpose alone, with its own bearer token, never the caller's.
  const [create] = s.toCredentialService();
  assert.equal(`${create.method} ${create.path}`, "POST /subscribers");
  assert.equal(create.body, { name: PURPOSE.name, description: PURPOSE.description });
  assert.equal(create.auth, `Bearer ${CREDENTIAL_TOKEN}`);

  const record = s.calls.find((c) => c.path === "/rest/v1/rpc/record_broker_account_created")!;
  assert.equal(record.auth, `Bearer ${CALLER_TOKEN}`, "recorded as the caller");
  assert.equal(record.body, { p_username: USERNAME, p_name: PURPOSE.name, p_description: PURPOSE.description });
  assert.ok(!JSON.stringify(record.body).includes(PASSWORD), "the password reached the database");
  assert.ok(!logged.join("\n").includes(PASSWORD), "the password reached the log");
  assert.ok(s.paths().indexOf("POST /subscribers") < s.paths().indexOf("POST /rest/v1/rpc/record_broker_account_created"));
});

Deno.test("a record that fails still returns the password, and says so", async () => {
  env();
  const s = stack({
    "POST /rest/v1/rpc/record_broker_account_created": { status: 400, body: { code: "22023", message: "bad name" } },
  });
  const { response, body } = await run(post({ action: "create", ...PURPOSE }), s);
  assert.equal(response.status, 200);
  assert.equal(body.password, PASSWORD);
  assert.equal(body.audit_recorded, false);
});

Deno.test("a credential service that fails or answers nonsense creates nothing the page is told of", async () => {
  for (const reply of [
    { status: 502, body: { error: "createClient: Client already exists", code: "broker_refused" } },
    { status: 401, body: { error: "unauthorized" } },
    { status: 200, body: { username: "gwy120000000000400080000", password: PASSWORD } },
    { status: 200, body: { username: USERNAME } },
  ]) {
    env();
    const s = stack({ "POST /subscribers": reply });
    const { response, body } = await run(post({ action: "create", ...PURPOSE }), s);
    assert.equal(response.status, 503, JSON.stringify(reply));
    assert.ok(!JSON.stringify(body).includes(PASSWORD));
    assert.ok(!s.paths().includes("POST /rest/v1/rpc/record_broker_account_created"), JSON.stringify(reply));
  }
});

Deno.test("a username outside the subscriber scheme is never sent to be deleted", async () => {
  for (const username of [
    "gwy120000000000400080000", "gwy110000000000400080000", "aber_ingestion", "aber_i3x", "aber_monitor",
    "dynsec-admin", "scada-reader", "SUB0A1B2C3D4E5F60718293A", `${USERNAME}0`, "", undefined, 42,
  ]) {
    env();
    const s = stack();
    const { response } = await run(post({ action: "delete", username }), s);
    assert.equal(response.status, 400, String(username));
    assert.equal(s.toCredentialService(), [], String(username));
  }
});

Deno.test("an Administrator deletes one, recorded with what the broker held", async () => {
  env();
  const s = stack();
  const { response, body } = await run(post({ action: "delete", username: USERNAME }), s);
  assert.equal(response.status, 200);
  assert.equal(body, { mqtt_username: USERNAME, deleted: true, audit_recorded: true });
  const [deletion] = s.toCredentialService();
  assert.equal(`${deletion.method} ${deletion.path}`, "POST /subscriber-deletions");
  assert.equal(deletion.body, { username: USERNAME });
  const record = s.calls.find((c) => c.path === "/rest/v1/rpc/record_broker_account_deleted")!;
  assert.equal(record.auth, `Bearer ${CALLER_TOKEN}`);
  assert.equal(record.body, { p_username: USERNAME, p_name: PURPOSE.name, p_description: PURPOSE.description });
});

Deno.test("deleting one the broker does not hold is a 404 with no record", async () => {
  env();
  const s = stack({
    "POST /subscriber-deletions": { status: 200, body: { username: USERNAME, existed: false, deleted: false } },
  });
  const { response } = await run(post({ action: "delete", username: USERNAME }), s);
  assert.equal(response.status, 404);
  assert.ok(!s.paths().includes("POST /rest/v1/rpc/record_broker_account_deleted"));
});

Deno.test("a credential service that cannot delete is a 503 with no record", async () => {
  env();
  const s = stack({ "POST /subscriber-deletions": { status: 502, body: { error: "the broker did not answer" } } });
  const { response } = await run(post({ action: "delete", username: USERNAME }), s);
  assert.equal(response.status, 503);
  assert.ok(!s.paths().includes("POST /rest/v1/rpc/record_broker_account_deleted"));
});

Deno.test("the scheme and the limits are the credential service's", () => {
  assert.ok(SUBSCRIBER_USERNAME.test(USERNAME));
  assert.ok(!SUBSCRIBER_USERNAME.test("gwy120000000000400080000"));
  assert.equal([NAME_MAX, DESCRIPTION_MAX], [80, 500]);
  assert.equal(purposeProblem("name", "é".repeat(80)), null);
  assert.ok(purposeProblem("name", "é".repeat(81)));
  assert.equal(purposeProblem("description", "  fine  "), null);
});
