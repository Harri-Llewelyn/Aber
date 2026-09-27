/**
 * The pin an appliance checks the platform's root against before it trusts anything else: the
 * SHA-256 of the root certificate's SubjectPublicKeyInfo, base64, which is what
 * `openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary
 * | base64` prints on the appliance (RFC 7469's form, RFC 7030 §4.1.1's idea). The public key and
 * not the certificate: deploy/k8s/internal-ca.yaml re-issues the root a year before it expires
 * with `rotationPolicy: Never`, so the key outlives the certificate and a pin on the key does not
 * break at the re-issue.
 *
 * The root arrives as ABER_CA_PEM, read at start by the image's entrypoint from the ingress TLS
 * Secret's ca.crt (functions.yaml mounts it), which is the root that signs the API's own
 * certificate: the appliance trusts the API through this pin, so it must be that root and not the
 * broker's, which is allowed to differ.
 */

/** The DER bytes of the first certificate in a PEM, or null when there is none. */
export function pemToDer(pem: string): Uint8Array | null {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  if (!match) return null;
  const base64 = match[1].replace(/[^A-Za-z0-9+/=]/g, "");
  try {
    const binary = atob(base64);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** One DER element at an offset: where its value starts, how long it is, and where it ends. */
function element(der: Uint8Array, offset: number): { tag: number; start: number; end: number } {
  if (offset + 2 > der.length) throw new Error("truncated DER");
  const tag = der[offset];
  let length = der[offset + 1];
  let cursor = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || cursor + count > der.length) throw new Error("bad DER length");
    length = 0;
    for (let i = 0; i < count; i += 1) length = (length << 8) | der[cursor + i];
    cursor += count;
  }
  if (cursor + length > der.length) throw new Error("truncated DER");
  return { tag, start: cursor, end: cursor + length };
}

/**
 * The SubjectPublicKeyInfo of an X.509 certificate, as the raw DER element. Certificate is a
 * SEQUENCE whose first child is the TBSCertificate SEQUENCE; inside it, an optional [0] version,
 * then serialNumber, signature, issuer, validity, subject, and the SPKI is the next element.
 */
export function subjectPublicKeyInfo(der: Uint8Array): Uint8Array {
  const certificate = element(der, 0);
  if (certificate.tag !== 0x30) throw new Error("not a certificate");
  const tbs = element(der, certificate.start);
  if (tbs.tag !== 0x30) throw new Error("not a certificate");
  let cursor = tbs.start;
  let skip = 5;
  if (der[cursor] === 0xa0) {
    cursor = element(der, cursor).end;
  }
  while (skip > 0) {
    cursor = element(der, cursor).end;
    skip -= 1;
  }
  const spki = element(der, cursor);
  if (spki.tag !== 0x30) throw new Error("no SubjectPublicKeyInfo where one was expected");
  return der.slice(cursor, spki.end);
}

/** The pin for a PEM certificate, or null when the PEM does not parse. */
export async function spkiPin(pem: string): Promise<string | null> {
  const der = pemToDer(pem);
  if (!der) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", subjectPublicKeyInfo(der));
    return btoa(String.fromCharCode(...new Uint8Array(digest)));
  } catch {
    return null;
  }
}

/** The root the platform pins, from the environment, or null when this deployment has none. */
export function platformRootPem(): string | null {
  const pem = (Deno.env.get("ABER_CA_PEM") ?? "").trim();
  return pem.includes("BEGIN CERTIFICATE") ? pem : null;
}
