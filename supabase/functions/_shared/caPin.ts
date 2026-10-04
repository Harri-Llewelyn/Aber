/**
 * The pin an appliance checks the platform's root against before it trusts anything else: the
 * SHA-256 of the root certificate's SubjectPublicKeyInfo, base64, which is what
 * `openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary
 * | base64` prints on the appliance (RFC 7469's form, RFC 7030 §4.1.1's idea). The public key and
 * not the certificate: deploy/k8s/internal-ca.yaml re-issues the root a year before it expires
 * with `rotationPolicy: Never`, so the key outlives the certificate and a pin on the key does not
 * break at the re-issue.
 *
 * The root is the ingress TLS Secret's ca.crt, which functions.yaml mounts at PLATFORM_ROOT_DIR:
 * the root that signs the API's own certificate. The appliance trusts the API through this pin, so
 * it must be that root and not the broker's, which is allowed to differ. A user worker cannot read
 * the mount, so main/index.ts reads it with platformRootReader() at each spawn until it holds a
 * root, and hands the worker ABER_CA_PEM and ABER_CA_STATE; the image's entrypoint reads ca.crt
 * once at start, and that value stands when main cannot read the mount.
 */

/**
 * Where functions.yaml mounts the ingress TLS Secret's ca.crt and tls.crt, when ingress TLS is on.
 * The volume is optional, so it is empty until cert-manager issues the Secret, and kubelet fills it
 * afterwards without a restart.
 */
export const PLATFORM_ROOT_DIR = "/home/deno/ca";

/**
 * What the mount holds. `root`: ca.crt is a certificate, so there is a pin. `no-root`: the
 * certificate is issued but its Secret carries no ca.crt, so there is no root to give an appliance;
 * only the internal CA is supported, and it always publishes one. `unissued`: the mount is there and
 * empty, so cert-manager has not issued the ingress certificate yet. `unmounted`: ingress TLS is off.
 */
export type PlatformRootState = "root" | "no-root" | "unissued" | "unmounted";

const STATES: PlatformRootState[] = ["root", "no-root", "unissued", "unmounted"];

/** Read the mount once. Throws on anything but a missing file, such as a denied read. */
export function readPlatformRoot(dir: string = PLATFORM_ROOT_DIR): { state: PlatformRootState; pem: string | null } {
  const missing = (err: unknown) => err instanceof Deno.errors.NotFound;
  try {
    if (!Deno.statSync(dir).isDirectory) return { state: "unmounted", pem: null };
  } catch (err) {
    if (missing(err)) return { state: "unmounted", pem: null };
    throw err;
  }
  const read = (name: string): string => {
    try {
      return Deno.readTextFileSync(`${dir}/${name}`).trim();
    } catch (err) {
      if (missing(err)) return "";
      throw err;
    }
  };
  const ca = read("ca.crt");
  if (ca.includes("BEGIN CERTIFICATE")) return { state: "root", pem: ca };
  return { state: read("tls.crt") ? "no-root" : "unissued", pem: null };
}

/**
 * A reader that reads the mount on every call until it holds a root, and then keeps that root: it
 * changes under a running pod only when the CA is re-issued, which keeps its key and so the pin.
 */
export function platformRootReader(dir: string = PLATFORM_ROOT_DIR): () => { state: PlatformRootState; pem: string | null } {
  let kept: { state: PlatformRootState; pem: string | null } | null = null;
  return () => {
    if (kept) return kept;
    const found = readPlatformRoot(dir);
    if (found.state === "root") kept = found;
    return found;
  };
}

/** What main/index.ts found in the mount, or null when it could not read it. */
export function platformRootState(): PlatformRootState | null {
  const state = Deno.env.get("ABER_CA_STATE") ?? "";
  return (STATES as string[]).includes(state) ? state as PlatformRootState : null;
}

/**
 * Why neither the bundle nor the install command is minted while the ingress certificate is
 * unissued: the bundle would carry no root, and the appliance's first call would fail.
 */
export const CERTIFICATE_UNISSUED =
  "cert-manager has not issued the platform's ingress TLS certificate yet, so an appliance could " +
  "not verify the platform (its first call would fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE). Wait " +
  "until the certificate is Ready and ask again; supabase-functions reads the root when it " +
  "appears, with no restart";

/** Whether to refuse both forms: an appliance must verify an HTTPS platform, and could not. */
export function platformRootMissing(publicUrl: string, state: PlatformRootState | null): boolean {
  return publicUrl.startsWith("https://") && (state === "unissued" || state === "no-root");
}

/** Why there is no root to pin, by what main/index.ts found in the mount. */
export function noRootReason(state: PlatformRootState | null): string {
  switch (state) {
    case "unissued":
      return CERTIFICATE_UNISSUED;
    case "no-root":
      return "the ingress TLS Secret has no ca.crt, so there is no root to give an appliance. Issue the " +
        "ingress certificate from the internal CA (deploy/k8s/internal-ca.yaml), which publishes its root there";
    case "root":
      return "the ingress TLS Secret's ca.crt does not parse as a certificate";
    case "unmounted":
      return "no platform root is mounted into the functions, because ingress.tls is off in the chart's values";
    default:
      return "supabase-functions could not read the platform root's mount and has none from its start " +
        "(restart supabase-functions)";
  }
}

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
 * then serialNumber, signature, issuer, validity, subject, and the SPKI is the next element. A
 * copy over its own ArrayBuffer, so typed as a BufferSource too, which crypto.subtle requires
 * (see _shared/zip.ts).
 */
export function subjectPublicKeyInfo(der: Uint8Array): Uint8Array & BufferSource {
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
