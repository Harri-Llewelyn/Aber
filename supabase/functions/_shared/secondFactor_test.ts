import {
  assuranceSuffices,
  MFA_REFUSAL,
  MFA_REFUSAL_CODE,
  MFA_SETTING,
  mfaSatisfied,
  secondFactorRefusal,
  tokenClaims,
} from "./secondFactor.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

const base64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const bearer = (claims: Record<string, unknown>) =>
  `Bearer ${base64url({ alg: "ES256", typ: "JWT" })}.${base64url(claims)}.signature`;

/** A client whose settings read answers `reply`, recording each key it was asked for. */
function settings(reply: SettingsReply) {
  const asked: string[] = [];
  const query = {
    select: () => query,
    eq: (_column: string, key: string) => {
      asked.push(key);
      return query;
    },
    maybeSingle: () => Promise.resolve(reply),
  };
  // deno-lint-ignore no-explicit-any -- a stand-in for the one call the helper makes
  const client = { from: () => query } as any;
  return { client, asked };
}

type SettingsReply = { data: { value: boolean } | null; error: { message: string } | null };
const ON: SettingsReply = { data: { value: true }, error: null };
const OFF: SettingsReply = { data: { value: false }, error: null };

Deno.test("a token's claims are read from its payload, and anything unreadable is none", () => {
  assert.equal(tokenClaims(bearer({ aal: "aal2", sub: "x" }).slice(7)).aal, "aal2");
  assert.equal(tokenClaims("not-a-token"), {});
  assert.equal(tokenClaims("a.!!!.c"), {});
  assert.equal(tokenClaims(`a.${base64url([1, 2])}.c`), {});
});

Deno.test("aal2 and a federated sign-in suffice; a password or a code-less session does not", () => {
  assert.equal(assuranceSuffices({ aal: "aal2" }), true);
  assert.equal(assuranceSuffices({ aal: "aal1", amr: [{ method: "oauth", timestamp: 1 }] }), true);
  assert.equal(assuranceSuffices({ aal: "aal1", amr: [{ method: "sso/saml" }] }), true);
  assert.equal(assuranceSuffices({ aal: "aal1", amr: [{ method: "password" }] }), false);
  // The method an app's code exchange records is not another identity provider.
  assert.equal(assuranceSuffices({ aal: "aal1", amr: [{ method: "oauth_provider/authorization_code" }] }), false);
  assert.equal(assuranceSuffices({}), false);
  assert.equal(assuranceSuffices({ amr: "oauth" }), false);
});

Deno.test("the predicate, as mfa_satisfied() answers it", async () => {
  const cases: [string, string | null, Record<string, unknown>, SettingsReply, boolean][] = [
    ["an Administrator at aal1, switch on", "Administrator", { aal: "aal1" }, ON, false],
    ["a Shopfloor Manager at aal1, switch on", "Shopfloor_Manager", { aal: "aal1" }, ON, false],
    ["an Administrator at aal1, switch off", "Administrator", { aal: "aal1" }, OFF, true],
    ["an Administrator at aal2, switch on", "Administrator", { aal: "aal2" }, ON, true],
    ["a federated Administrator, switch on", "Administrator", { aal: "aal1", amr: [{ method: "oauth" }] }, ON, true],
    ["an Operator at aal1, switch on", "Operator", { aal: "aal1" }, ON, true],
    ["an Auditor at aal1, switch on", "Auditor", { aal: "aal1" }, ON, true],
    ["no role, switch on", null, {}, ON, true],
    ["a row that is missing", "Administrator", { aal: "aal1" }, { data: null, error: null }, true],
  ];
  for (const [label, role, claims, reply, expected] of cases) {
    const { client } = settings(reply);
    assert.equal(await mfaSatisfied(client, role, claims), expected, label);
  }
});

Deno.test("the switch is read only when the role and the session leave it to decide", async () => {
  for (const [role, claims] of [["Operator", { aal: "aal1" }], ["Administrator", { aal: "aal2" }]] as const) {
    const { client, asked } = settings(ON);
    await mfaSatisfied(client, role, claims);
    assert.equal(asked, [], `${role} ${claims.aal}`);
  }
  const { client, asked } = settings(ON);
  await mfaSatisfied(client, "Administrator", { aal: "aal1" });
  assert.equal(asked, [MFA_SETTING]);
});

Deno.test("a refusal is 403 with the sentence, an unread switch 503, and admission nothing", async () => {
  const refused = await secondFactorRefusal(settings(ON).client, "Administrator", bearer({ aal: "aal1" }));
  assert.equal(refused, {
    status: 403,
    body: { error: "Forbidden: MFA required", details: MFA_REFUSAL, code: MFA_REFUSAL_CODE },
  });
  assert.equal(MFA_REFUSAL.includes("Profile › MFA"), true, "the sentence names where to add one");

  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    const unread = await secondFactorRefusal(settings({ data: null, error: { message: "boom" } }).client,
      "Shopfloor_Manager", bearer({ aal: "aal1" }));
    assert.equal(unread?.status, 503);
    assert.equal(logged.some((l) => l.includes("boom")), true, "the failure is logged");
  } finally {
    console.error = original;
  }

  assert.equal(await secondFactorRefusal(settings(ON).client, "Administrator", bearer({ aal: "aal2" })), null);
  assert.equal(await secondFactorRefusal(settings(OFF).client, "Administrator", bearer({ aal: "aal1" })), null);
  assert.equal(await secondFactorRefusal(settings(ON).client, "Operator", bearer({ aal: "aal1" })), null);
  // An unreadable token is no aal2: the switch decides.
  assert.equal((await secondFactorRefusal(settings(ON).client, "Administrator", "Bearer garbage"))?.status, 403);
});
