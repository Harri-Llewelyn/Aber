import {
  CERTIFICATE_UNISSUED,
  certificateUnissued,
  noRootReason,
  platformRootReader,
  platformRootState,
  readPlatformRoot,
} from "./caPin.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  deepEqual(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
  equal(actual: unknown, expected: unknown, message = "") {
    assert.deepEqual(actual, expected, message);
  },
  match(text: string, pattern: RegExp) {
    if (!pattern.test(text)) throw new Error(`${JSON.stringify(text)} does not match ${pattern}`);
  },
};

// The shape kubelet gives an optional Secret volume, as files: ca.crt and tls.crt, or nothing.
const ROOT = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
const LEAF = "-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----";

function mount(files: Record<string, string> = {}): string {
  const dir = Deno.makeTempDirSync();
  for (const [name, text] of Object.entries(files)) Deno.writeTextFileSync(`${dir}/${name}`, text);
  return dir;
}

Deno.test("no mount is ingress TLS off", () => {
  assert.deepEqual(readPlatformRoot(`${mount()}/absent`), { state: "unmounted", pem: null });
});

Deno.test("an empty mount is a certificate not yet issued, with no pin", () => {
  assert.deepEqual(readPlatformRoot(mount()), { state: "unissued", pem: null });
});

Deno.test("a certificate with no ca.crt, or an empty one, is an issuer that publishes no root", () => {
  assert.deepEqual(readPlatformRoot(mount({ "tls.crt": LEAF })), { state: "no-root", pem: null });
  assert.deepEqual(readPlatformRoot(mount({ "tls.crt": LEAF, "ca.crt": "" })), { state: "no-root", pem: null });
});

Deno.test("a ca.crt holding a certificate is the root", () => {
  assert.deepEqual(readPlatformRoot(mount({ "tls.crt": LEAF, "ca.crt": `${ROOT}\n` })), { state: "root", pem: ROOT });
});

Deno.test("the reader picks the root up when it appears, and keeps it", () => {
  const dir = mount();
  const read = platformRootReader(dir);
  assert.equal(read().state, "unissued");
  assert.equal(read().state, "unissued", "read again while empty");

  Deno.writeTextFileSync(`${dir}/ca.crt`, ROOT);
  Deno.writeTextFileSync(`${dir}/tls.crt`, LEAF);
  assert.deepEqual(read(), { state: "root", pem: ROOT });

  Deno.removeSync(`${dir}/ca.crt`);
  assert.deepEqual(read(), { state: "root", pem: ROOT }, "kept once read");
});

Deno.test("the state reaches the worker as ABER_CA_STATE, and anything else reads as unknown", () => {
  try {
    Deno.env.set("ABER_CA_STATE", "unissued");
    assert.equal(platformRootState(), "unissued");
    Deno.env.set("ABER_CA_STATE", "something");
    assert.equal(platformRootState(), null);
    Deno.env.delete("ABER_CA_STATE");
    assert.equal(platformRootState(), null);
  } finally {
    Deno.env.delete("ABER_CA_STATE");
  }
});

Deno.test("an unissued certificate is refused with its cause and remedy; each state says why", () => {
  assert.equal(certificateUnissued("https://api.factory.example", "unissued"), true);
  assert.equal(certificateUnissued("http://api.localhost", "unissued"), false, "plain HTTP verifies nothing");
  for (const state of ["root", "no-root", "unmounted", null] as const) {
    assert.equal(certificateUnissued("https://api.factory.example", state), false, String(state));
  }
  assert.equal(noRootReason("unissued"), CERTIFICATE_UNISSUED);
  assert.match(CERTIFICATE_UNISSUED, /not issued/);
  assert.match(CERTIFICATE_UNISSUED, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  assert.match(CERTIFICATE_UNISSUED, /no restart/);
  assert.match(noRootReason("no-root"), /ACME/);
  assert.match(noRootReason("unmounted"), /ingress\.tls is off/);
  assert.match(noRootReason(null), /restart supabase-functions/);
});
