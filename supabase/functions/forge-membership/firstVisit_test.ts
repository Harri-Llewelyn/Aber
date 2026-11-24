import { BOUNCED_PARAM, firstVisitBounce, isPageLoad, PATH_PREFIX, pathAskedFor, REGISTERING_PATH } from "./firstVisit.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

const LOGIN = "aaaaaaaa-0000-4000-8000-000000000001";
const SOMEONE_ELSE = "bbbbbbbb-0000-4000-8000-000000000002";
const REPOSITORY = "/gateways/gateway-gwy000000000000000000001";
const DOOR = "http://git.site.test";
const NAVIGATION = { "Sec-Fetch-Mode": "navigate", Accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

/** What the listener sends for a browser's request: its path under the prefix, on the door's host. */
const url = (pathAndQuery: string) => `${DOOR}${PATH_PREFIX}${pathAndQuery}`;

/** The bounce of one request, the URL exactly as given: a Request would normalise it first. */
function bounce(pathAndQuery: string, headers: Record<string, string> = NAVIGATION, method = "GET") {
  return firstVisitBounce({ method, url: url(pathAndQuery), headers: new Headers(headers) }, LOGIN);
}

/** The address a bounce comes back to, as Gitea reads it. */
function comesBackTo(location: string | null): string | null {
  return new URL(location ?? "", DOOR).searchParams.get("redirect_to");
}

Deno.test("a page load is a GET the browser calls a navigation, or one that accepts a page where it says nothing", () => {
  const cases: [string, Record<string, string>, boolean][] = [
    ["GET", { "Sec-Fetch-Mode": "navigate" }, true],
    ["GET", NAVIGATION, true],
    ["GET", { Accept: "text/html" }, true],
    ["GET", { Accept: "application/xhtml+xml, Text/HTML;q=0.9" }, true],
    // Sec-Fetch-Mode decides wherever the browser sends it.
    ["GET", { "Sec-Fetch-Mode": "cors", Accept: "text/html" }, false],
    ["GET", { "Sec-Fetch-Mode": "same-origin", Accept: "text/html" }, false],
    ["GET", { "Sec-Fetch-Mode": "no-cors", Accept: "image/avif,*/*" }, false],
    ["GET", { Accept: "application/json" }, false],
    ["GET", { Accept: "text/event-stream" }, false],
    ["GET", { Accept: "*/*" }, false],
    ["GET", { Accept: "text/htmlx" }, false],
    ["GET", {}, false],
    ["POST", NAVIGATION, false],
    ["HEAD", NAVIGATION, false],
    ["PUT", NAVIGATION, false],
  ];
  for (const [method, headers, expected] of cases) {
    assert.equal(isPageLoad(method, new Headers(headers)), expected, `${method} ${JSON.stringify(headers)}`);
  }
});

Deno.test("a page load goes through Gitea's sign-in path and comes back to its own path and query", () => {
  const cases: [string, string][] = [
    ["/", `/?${BOUNCED_PARAM}=${LOGIN}`],
    [REPOSITORY, `${REPOSITORY}?${BOUNCED_PARAM}=${LOGIN}`],
    [`${REPOSITORY}?`, `${REPOSITORY}?${BOUNCED_PARAM}=${LOGIN}`],
    [
      `${REPOSITORY}/compare/main...appliance?style=split&q=a%20b`,
      `${REPOSITORY}/compare/main...appliance?style=split&q=a%20b&${BOUNCED_PARAM}=${LOGIN}`,
    ],
    [`${REPOSITORY}/src/branch/feature%2Fx`, `${REPOSITORY}/src/branch/feature%2Fx?${BOUNCED_PARAM}=${LOGIN}`],
    // Encoded in a query, a backslash leaves the host where it is.
    [`${REPOSITORY}/issues?q=a%5Cb`, `${REPOSITORY}/issues?q=a%5Cb&${BOUNCED_PARAM}=${LOGIN}`],
  ];
  for (const [asked, back] of cases) {
    const location = bounce(asked);
    assert.equal(comesBackTo(location), back, asked);
    assert.equal(location, `${REGISTERING_PATH}?redirect_to=${encodeURIComponent(back)}`, asked);
    assert.equal(new URL(location ?? "", DOOR).origin, DOOR, asked);
  }
});

Deno.test("a request that is not a page load is never bounced", () => {
  assert.equal(bounce("/user/events", { Accept: "text/event-stream" }), null);
  assert.equal(bounce("/repo/search?q=gateway", { "Sec-Fetch-Mode": "same-origin", Accept: "application/json" }), null);
  assert.equal(bounce(`${REPOSITORY}/issues/new`, NAVIGATION, "POST"), null);
  assert.equal(bounce(REPOSITORY, {}), null);
});

Deno.test("Gitea's sign-in path is let through, whatever it carries, or nothing would register the login", () => {
  for (const asked of [REGISTERING_PATH, `${REGISTERING_PATH}?redirect_to=%2Fgateways`, `${REGISTERING_PATH}?`]) {
    assert.equal(bounce(asked), null, asked);
  }
});

Deno.test("a path that could leave the host, or that the listener did not send, is not followed", () => {
  const refused = [
    "//evil.example/x", "///evil.example", "/\\evil.example", "/%5Cevil.example", "/%5cevil.example",
    `${REPOSITORY}/src/branch/main/a%5Cb`, `${REPOSITORY}\\x`, `${REPOSITORY}?q=\\`, "/x/..//evil.example",
    "/%2e%2e//evil.example",
    // Off the prefix, as a direct call to the function is.
    "", "?redirect_to=%2Fx", "evil/x",
  ];
  for (const asked of refused) {
    assert.equal(pathAskedFor(url(asked)), null, asked);
    assert.equal(bounce(asked), null, asked);
  }
});

Deno.test("nothing the caller names chooses the return address", () => {
  const elsewhere = "https://evil.example/";
  const location = bounce(`${REPOSITORY}?redirect_to=${encodeURIComponent(elsewhere)}&next=${encodeURIComponent(elsewhere)}`, {
    ...NAVIGATION,
    Host: "evil.example",
    Referer: elsewhere,
    "X-Forwarded-Host": "evil.example",
    "X-Original-URL": elsewhere,
  });
  const back = comesBackTo(location);
  assert.equal(new URL(location ?? "", DOOR).origin, DOOR);
  assert.equal(back?.startsWith(`${REPOSITORY}?`), true, `${back}`);
  assert.equal(new URL(back ?? "", DOOR).origin, DOOR);
});

Deno.test("a return address is never bounced again, and another person's still bounces this one", () => {
  for (const asked of ["/", REPOSITORY, `${REPOSITORY}/wiki?x=1`, `${REPOSITORY}?${BOUNCED_PARAM}=${SOMEONE_ELSE}`]) {
    const back = comesBackTo(bounce(asked));
    assert.equal(back?.endsWith(`${BOUNCED_PARAM}=${LOGIN}`), true, `${asked} came back as ${back}`);
    assert.equal(bounce(back ?? ""), null, `${asked} came back as ${back}`);
  }
  assert.equal(bounce(`${REPOSITORY}?${BOUNCED_PARAM}=${LOGIN}`), null);
  assert.equal(bounce(`${REPOSITORY}?${BOUNCED_PARAM}=1`) !== null, true);
});
