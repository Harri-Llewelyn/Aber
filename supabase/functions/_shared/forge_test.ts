import { knownHostsHost } from "./forge.ts";

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
