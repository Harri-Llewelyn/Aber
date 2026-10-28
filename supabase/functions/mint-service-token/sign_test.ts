import { signingKeyFrom, signServiceToken } from "./sign.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
function equal(actual: unknown, expected: unknown, message = "") {
  const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
  if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
}
async function refused(run: () => unknown, includes: string) {
  try {
    await run();
  } catch (err) {
    if (err instanceof Error && err.message.includes(includes)) return;
    throw new Error(`expected an error naming "${includes}", got ${err}`);
  }
  throw new Error(`expected an error naming "${includes}", and nothing was thrown`);
}

const SECRET = "mint-service-token-test-secret-of-32-characters";
const KID = "mint-test-kid";
const bytes = (text: string) => new TextEncoder().encode(text);

function base64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
const decode = (part: string) => JSON.parse(new TextDecoder().decode(base64url(part)));

/** A key set as setup.mjs writes it: the private key that signs, and the legacy secret. */
async function keySet() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const legacy = { kty: "oct", k: btoa(SECRET).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), alg: "HS256" };
  const signing = {
    kty: "EC", kid: KID, use: "sig", alg: "ES256", crv: "P-256", x: priv.x, y: priv.y, d: priv.d,
    key_ops: ["sign", "verify"],
  };
  return { jwtKeys: JSON.stringify([signing, legacy]), publicKey: pair.publicKey };
}

const claims = { sub: "b0000000-0000-4000-8000-000000000001", role: "authenticated", jti: "j", iat: 1, exp: 4102444800 };

Deno.test("with JWT_KEYS the token is ES256 under the signing key's kid, and verifies with its public half", async () => {
  const { jwtKeys, publicKey } = await keySet();
  const { token, alg } = await signServiceToken(claims, { jwtKeys, jwtSecret: SECRET });
  equal(alg, "ES256");
  const [header, payload, signature] = token.split(".");
  equal(decode(header), { alg: "ES256", typ: "JWT", kid: KID });
  equal(decode(payload), claims);
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, publicKey, base64url(signature), bytes(`${header}.${payload}`));
  equal(verified, true, "the public key verifies the signature");
});

Deno.test("with JWT_SECRET alone the token is HS256 with no kid, as before", async () => {
  const { token, alg } = await signServiceToken(claims, { jwtSecret: SECRET });
  equal(alg, "HS256");
  const [header, payload, signature] = token.split(".");
  equal(decode(header), { alg: "HS256", typ: "JWT" });
  const key = await crypto.subtle.importKey("raw", bytes(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  equal(await crypto.subtle.verify("HMAC", key, base64url(signature), bytes(`${header}.${payload}`)), true);
});

Deno.test("a key set GoTrue would refuse is refused, and so is no key at all", async () => {
  const keys = JSON.parse((await keySet()).jwtKeys);
  await refused(() => signingKeyFrom(JSON.stringify([keys[1]])), "exactly one key");
  await refused(() => signingKeyFrom(JSON.stringify([keys[0], { ...keys[0], kid: "b" }])), "exactly one key");
  await refused(() => signingKeyFrom(JSON.stringify([{ ...keys[0], kid: "" }])), "a kid");
  await refused(() => signingKeyFrom("{}"), "JSON array");
  await refused(() => signServiceToken(claims, {}), "neither");
});
