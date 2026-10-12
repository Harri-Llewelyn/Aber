import { forgeApi, forgeConfig, knownHostsHost } from "./forge.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// OpenSSH looks a non-default port up as `[host]:port` and port 22 as the bare host, so an entry in
// the other form is a known_hosts file that verifies nothing and every clone is refused.
Deno.test("a clone URL on a port other than 22 names [host]:port", () => {
  equal(knownHostsHost("ssh://git@git.plant.example:2222/gateways/gateway-gwy1.git"), "[git.plant.example]:2222");
  equal(knownHostsHost("ssh://git@10.20.0.50:2222/platform/gateway-platform.git"), "[10.20.0.50]:2222");
  equal(knownHostsHost("  ssh://git.localhost:30022/gateways/x.git\n"), "[git.localhost]:30022");
});

Deno.test("a clone URL on 22 names the bare host", () => {
  equal(knownHostsHost("ssh://git@git.plant.example:22/gateways/gateway-gwy1.git"), "git.plant.example");
  equal(knownHostsHost("ssh://git@git.plant.example/gateways/gateway-gwy1.git"), "git.plant.example");
  // Gitea's form on 22: the colon separates the path, never a port.
  equal(knownHostsHost("git@git.plant.example:gateways/gateway-gwy1.git"), "git.plant.example");
  equal(knownHostsHost("git@git.plant.example:2222/gateways/x.git"), "git.plant.example");
});

Deno.test("a URL that is not SSH names no host", () => {
  equal(knownHostsHost("https://git.plant.example/gateways/gateway-gwy1.git"), null);
  equal(knownHostsHost(""), null);
});

/** forgeConfig() under the given forge variables, the others unset, and the environment put back. */
function configWith(vars: Record<string, string>) {
  const names = ["GITEA_INTERNAL_URL", "GITEA_MACHINE_USER", "GITEA_MACHINE_TOKEN", "GITEA_WEBHOOK_URL", "GITEA_WEBHOOK_SECRET"];
  const saved = Object.fromEntries(names.map((n) => [n, Deno.env.get(n)]));
  try {
    for (const n of names) {
      if (n in vars) Deno.env.set(n, vars[n]);
      else Deno.env.delete(n);
    }
    return forgeConfig();
  } finally {
    for (const n of names) {
      const v = saved[n];
      if (v === undefined) Deno.env.delete(n);
      else Deno.env.set(n, v);
    }
  }
}

// What the forge mints: 40 hex characters. One repeated so no scanner reads it as a credential.
const DELIVERED = "f".repeat(40);
const FORGE = { GITEA_INTERNAL_URL: "http://gitea:3000/", GITEA_MACHINE_USER: "aber_platform" };

Deno.test("a deployment with no forge variables has no forge", () => {
  equal(configWith({}), null);
});

// main/index.ts forwards "" when the mount is there and the forge has not written the token yet:
// the first minute of an install or an upgrade, which must end on its own rather than need a restart.
Deno.test("a token not yet delivered is no forge for this call, and a delivered one is used", () => {
  equal(configWith({ ...FORGE, GITEA_MACHINE_TOKEN: "" }), null);
  const cfg = configWith({ ...FORGE, GITEA_MACHINE_TOKEN: DELIVERED });
  equal(cfg?.token, DELIVERED);
  equal(cfg?.baseUrl, "http://gitea:3000");
});

Deno.test("a forge with no token variable at all is half-configured", () => {
  equal(configWith(FORGE), null);
});

// The account is a bot: Gitea refuses it a password, so the token is the whole credential.
Deno.test("every call carries the token, never Basic", async () => {
  const cfg = configWith({ ...FORGE, GITEA_MACHINE_TOKEN: DELIVERED })!;
  const realFetch = globalThis.fetch;
  let sent = "";
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
    sent = new Headers(init?.headers).get("Authorization") ?? "";
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  try {
    await forgeApi(cfg, "GET", "/user");
  } finally {
    globalThis.fetch = realFetch;
  }
  equal(sent, `token ${DELIVERED}`);
});
