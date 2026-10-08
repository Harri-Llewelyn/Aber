import { lookUpUserRole, resolveUserRole } from "./roles.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  deepEqual(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
  equal(actual: unknown, expected: unknown, message = "") {
    assert.deepEqual(actual, expected, message);
  },
};

const USER_ID = "aaaaaaaa-0000-4000-8000-000000000001";

type Reply = { data: unknown; error: { message: string } | null };

const base64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A caller's token whose `app_metadata.role` claims Administrator. */
const CLAIMING_JWT = [
  base64url({ alg: "HS256", typ: "JWT" }),
  base64url({ sub: USER_ID, role: "authenticated", app_metadata: { role: "Administrator" } }),
  "signature",
].join(".");

/**
 * A client that answers the query with `reply` and records each call. It carries the claiming token
 * everywhere a supabase-js client exposes one (the Authorization header, `auth.getUser`,
 * `auth.getSession`), and records any use of `auth`, so a lookup that consulted the claim shows in
 * `calls` and in its result.
 */
function fakeClient(reply: Reply) {
  const calls: string[] = [];
  const query = {
    select(columns: string) {
      calls.push(`select ${columns}`);
      return query;
    },
    eq(column: string, value: string) {
      calls.push(`eq ${column}=${value}`);
      return query;
    },
    maybeSingle() {
      calls.push("maybeSingle");
      return Promise.resolve(reply);
    },
  };
  const user = { id: USER_ID, app_metadata: { role: "Administrator" }, user_metadata: { role: "Administrator" } };
  const client = {
    headers: { Authorization: `Bearer ${CLAIMING_JWT}` },
    from(table: string) {
      calls.push(`from ${table}`);
      return query;
    },
    auth: {
      getUser() {
        calls.push("auth.getUser");
        return Promise.resolve({ data: { user }, error: null });
      },
      getSession() {
        calls.push("auth.getSession");
        return Promise.resolve({ data: { session: { access_token: CLAIMING_JWT, user } }, error: null });
      },
    },
  };
  return { client: client as unknown as Parameters<typeof resolveUserRole>[0], calls };
}

/** Run `fn` with console.error captured, so an expected failure log is asserted rather than printed. */
async function capturingErrors<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = original;
  }
}

const LOOKUP = ["from user_roles", "select roles(name)", `eq user_id=${USER_ID}`, "maybeSingle"];

Deno.test("the role is the user's public.user_roles row, looked up by user id", async () => {
  const { client, calls } = fakeClient({ data: { roles: { name: "Shopfloor_Manager" } }, error: null });
  assert.equal(await resolveUserRole(client, USER_ID), "Shopfloor_Manager");
  assert.deepEqual(calls, LOOKUP);
});

Deno.test("a token claiming app_metadata.role with no user_roles row has no role", async () => {
  const { client, calls } = fakeClient({ data: null, error: null });
  assert.equal(await resolveUserRole(client, USER_ID), null);
  assert.deepEqual(calls, LOOKUP, "the claim is never consulted");
});

Deno.test("a failed lookup is no role, and is logged", async () => {
  for (const data of [null, { roles: { name: "Administrator" } }]) {
    const { client } = fakeClient({ data, error: { message: "permission denied for table user_roles" } });
    const { result, logged } = await capturingErrors(() => resolveUserRole(client, USER_ID));
    assert.equal(result, null, `data ${JSON.stringify(data)} beside an error`);
    assert.equal(logged.length, 1, "one log line");
    assert.equal(logged[0].includes(USER_ID) && logged[0].includes("permission denied"), true, logged[0]);
  }
});

Deno.test("a row whose role is not a name is no role", async () => {
  for (const data of [{}, { roles: null }, { roles: {} }, { roles: { name: 42 } }, { roles: [{ name: "Administrator" }] }]) {
    const { client } = fakeClient({ data, error: null });
    assert.equal(await resolveUserRole(client, USER_ID), null, JSON.stringify(data));
  }
});

Deno.test("lookUpUserRole reads the same row, and throws where resolveUserRole answers null", async () => {
  const found = fakeClient({ data: { roles: { name: "Administrator" } }, error: null });
  assert.equal(await lookUpUserRole(found.client, USER_ID), "Administrator");
  assert.deepEqual(found.calls, LOOKUP);
  assert.equal(await lookUpUserRole(fakeClient({ data: null, error: null }).client, USER_ID), null);

  const failing = fakeClient({ data: null, error: { message: "permission denied for table user_roles" } });
  let thrown = "";
  try {
    await lookUpUserRole(failing.client, USER_ID);
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
  assert.equal(thrown.includes(USER_ID) && thrown.includes("permission denied"), true, thrown);
});
