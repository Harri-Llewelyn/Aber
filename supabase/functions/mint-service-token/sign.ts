/**
 * Signs a service-principal token ES256, with the kid of the signing key in JWT_KEYS (GoTrue's
 * signing set). No service accepts an HS256 token, so nothing here signs one.
 */

import { create, type Payload } from "djwt";

/** The key GoTrue signs with, found as GoTrue finds it: the one whose key_ops hold `sign`. */
export function signingKeyFrom(jwtKeys: string): JsonWebKey & { kid: string } {
  const keys = JSON.parse(jwtKeys);
  if (!Array.isArray(keys)) throw new Error("JWT_KEYS must be a JSON array of JWKs");
  const signing = keys.filter((k) => Array.isArray(k?.key_ops) && k.key_ops.includes("sign"));
  if (signing.length !== 1) {
    throw new Error(`JWT_KEYS must hold exactly one key with "sign" in key_ops; it holds ${signing.length}`);
  }
  const [key] = signing;
  if (key.kty !== "EC" || key.crv !== "P-256" || key.alg !== "ES256" || !key.kid || !key.d) {
    throw new Error("the signing key in JWT_KEYS must be an EC P-256 private key with alg ES256 and a kid");
  }
  return key;
}

/** The signed token. No JWT_KEYS is a misconfiguration the handler answers as one. */
export async function signServiceToken(
  payload: Payload,
  { jwtKeys }: { jwtKeys?: string },
): Promise<{ token: string; alg: "ES256" }> {
  if (!jwtKeys) throw new Error("JWT_KEYS is not set");
  const { kid, crv, x, y, d } = signingKeyFrom(jwtKeys);
  // The key's own members alone; kid, use and key_ops are the set's bookkeeping.
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv, x, y, d },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { token: await create({ alg: "ES256", typ: "JWT", kid }, payload, key), alg: "ES256" };
}
