import { holdsDeployKey } from "./keys.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

Deno.test("a Remote gateway in service holds its appliance's key", () => {
  assert.equal(holdsDeployKey({ is_archived: false, deployment: "remote" }), true);
});

Deno.test("an archived Remote gateway holds none", () => {
  assert.equal(holdsDeployKey({ is_archived: true, deployment: "remote" }), false);
});

Deno.test("a gateway changed away from Remote holds none, archived or not", () => {
  for (const deployment of ["host", "third_party"]) {
    assert.equal(holdsDeployKey({ is_archived: false, deployment }), false, deployment);
    assert.equal(holdsDeployKey({ is_archived: true, deployment }), false, `${deployment}, archived`);
  }
});

Deno.test("a repository whose gateway row is gone holds none", () => {
  assert.equal(holdsDeployKey(undefined), false);
});
