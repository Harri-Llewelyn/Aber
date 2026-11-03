import { AUTH_PROBE, checkCaller } from "./callerCheck.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  deepEqual(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

type Reply = { data: unknown; error: { message: string } | null; status: number };

/** A client whose probe answers `reply`, recording each call and any use of `auth`. */
function fakeClient(reply: Reply) {
  const calls: string[] = [];
  const client = {
    rpc(fn: string, args: unknown, options: unknown) {
      calls.push(`rpc ${fn} ${JSON.stringify(args)} ${JSON.stringify(options)}`);
      return Promise.resolve(reply);
    },
    auth: {
      getUser() {
        calls.push("auth.getUser");
        return Promise.resolve({ data: { user: { id: "someone" } }, error: null });
      },
    },
  };
  // deno-lint-ignore no-explicit-any -- a stand-in for the parts of SupabaseClient the check uses
  return { client: client as any, calls };
}

Deno.test("a token PostgREST accepts is accepted, with one GET to the probe and no GoTrue call", async () => {
  const { client, calls } = fakeClient({ data: true, error: null, status: 200 });
  assert.deepEqual(await checkCaller(client), { accepted: true });
  assert.deepEqual(calls, [`rpc ${AUTH_PROBE} {} {"get":true}`]);
});

Deno.test("PostgREST's 401 and 403 are refusals, carrying its reason", async () => {
  for (
    const [status, message] of [
      [401, "JWT expired"],
      [403, "this token has been revoked"],
      [403, "this identity has been revoked"],
    ] as const
  ) {
    const { client } = fakeClient({ data: null, error: { message }, status });
    assert.deepEqual(await checkCaller(client), { accepted: false, refused: true, reason: message }, `${status}`);
  }
});

Deno.test("a key, which the probe's grant refuses, is told a token is required", async () => {
  for (const status of [401, 403]) {
    const { client } = fakeClient({
      data: null,
      error: { message: "permission denied for function auth_probe" },
      status,
    });
    assert.deepEqual(await checkCaller(client), {
      accepted: false,
      refused: true,
      reason: "a person's or a machine identity's access token is required",
    }, `${status}`);
  }
});

Deno.test("a probe that could not answer is neither an acceptance nor a refusal", async () => {
  for (
    const reply of [
      { data: null, error: { message: "FetchError: connection refused" }, status: 0 },
      { data: null, error: { message: "upstream connect error" }, status: 503 },
      { data: null, error: null, status: 200 },
      { data: false, error: null, status: 200 },
    ]
  ) {
    const { client } = fakeClient(reply);
    const result = await checkCaller(client);
    assert.deepEqual([result.accepted, "refused" in result && result.refused], [false, false], JSON.stringify(reply));
  }
});
