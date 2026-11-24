import { BOUNCED_PARAM, PATH_PREFIX, REGISTERING_PATH } from "./firstVisit.ts";
import { handler } from "./membership.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
};

const GATEWAY = "http://gateway.test";
const FORGE = "http://forge-api.test";
const DOOR = "http://git.site.test";
const REPOSITORY = "/gateways/gateway-gwy000000000000000000001";
const NAVIGATION = { "Sec-Fetch-Mode": "navigate", Accept: "text/html" };
const ENVIRONMENT: Record<string, string> = {
  SUPABASE_URL: GATEWAY,
  SUPABASE_PUBLISHABLE_KEY: "publishable-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-jwt",
  GITEA_INTERNAL_URL: FORGE,
  GITEA_MACHINE_USER: "aber_platform",
  GITEA_MACHINE_TOKEN: "not-a-real-token",
};
const NO_FORGE = Object.fromEntries(Object.entries(ENVIRONMENT).filter(([name]) => !name.startsWith("GITEA_")));
const TEAM_IDS: Record<string, number> = { administrators: 1, managers: 2, readers: 3 };

/** A login no other test uses: the handler remembers for minutes whom it has placed. */
let logins = 0;
const newLogin = () => `aaaaaaaa-0000-4000-8000-${String(++logins).padStart(12, "0")}`;

type World = {
  login: string;
  role: string | null;
  /** Whether Gitea's API knows the login: asked afresh on each lookup, so a test may have it vary. */
  registered: () => boolean;
  /** What Gitea's sign-in path does with the login, and whether it then follows redirect_to. */
  onSignIn: () => void;
  signsIn: boolean;
  sessionEnded: boolean;
  forgeDown: boolean;
  seats: Set<string>;
};

/** A person the forge has never seen, whom Gitea registers on its sign-in path as 28.3.0 does. */
function newcomer(role: string | null, changes: Partial<World> = {}): World {
  let known = false;
  return {
    login: newLogin(),
    role,
    registered: () => known,
    onSignIn: () => {
      known = true;
    },
    signsIn: true,
    sessionEnded: false,
    forgeDown: false,
    seats: new Set<string>(),
    ...changes,
  };
}

function reply(status: number, body: unknown = null): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** GoTrue, PostgREST, and the forge's API as the machine account sees it. */
function answer(req: Request, w: World): Response {
  const { origin, pathname } = new URL(req.url);
  if (origin === GATEWAY && pathname === "/auth/v1/user") {
    return w.sessionEnded
      ? reply(403, { code: 403, error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" })
      : reply(200, { id: w.login, aud: "authenticated", email: "person@site.test" });
  }
  if (origin === GATEWAY && pathname === "/rest/v1/user_roles") {
    return reply(200, w.role === null ? [] : [{ roles: { name: w.role } }]);
  }
  if (origin === FORGE) {
    if (w.forgeDown) throw new TypeError("connection refused");
    const path = pathname.slice("/api/v1".length);
    if (path === "/orgs/gateways" || path === "/orgs/platform") return reply(200, {});
    if (path === "/orgs/gateways/teams") {
      return reply(200, ["administrators", "managers"].map((name) => ({ id: TEAM_IDS[name], name, can_create_org_repo: true })));
    }
    if (path === "/orgs/platform/teams") return reply(200, [{ id: TEAM_IDS.readers, name: "readers" }]);
    if (path === `/users/${w.login}`) return w.registered() ? reply(200, { login: w.login }) : reply(404);
    for (const [team, id] of Object.entries(TEAM_IDS)) {
      if (path !== `/teams/${id}/members/${w.login}`) continue;
      if (req.method === "GET") return w.seats.has(team) ? reply(200, {}) : reply(404);
      if (req.method === "PUT") w.seats.add(team);
      if (req.method === "DELETE") w.seats.delete(team);
      return reply(204);
    }
  }
  throw new Error(`unexpected ${req.method} ${req.url}`);
}

type Asked = { headers?: Record<string, string>; method?: string; env?: Record<string, string> };

/** One request at the door: what the listener sends the function for it, and what the function answers. */
async function atTheDoor(w: World, path: string, { headers = NAVIGATION, method = "GET", env = ENVIRONMENT }: Asked = {}) {
  const saved = Object.keys(ENVIRONMENT).map((name) => [name, Deno.env.get(name)] as const);
  const [log, warn, error, originalFetch] = [console.log, console.warn, console.error, globalThis.fetch];
  console.log = console.warn = console.error = () => {};
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    try {
      return Promise.resolve(answer(new Request(input, init), w));
    } catch (err) {
      return Promise.reject(err);
    }
  };
  for (const [name] of saved) {
    if (name in env) Deno.env.set(name, env[name]);
    else Deno.env.delete(name);
  }
  try {
    const response = await handler(
      new Request(`${DOOR}${PATH_PREFIX}${path}`, { method, headers: { Authorization: "Bearer door-session", ...headers } }),
    );
    const text = await response.text();
    return { status: response.status, location: response.headers.get("Location"), body: text ? JSON.parse(text) : null };
  } finally {
    [console.log, console.warn, console.error, globalThis.fetch] = [log, warn, error, originalFetch];
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

/** Gitea's answer to a page load the door let through. */
function atGitea(w: World, path: string): { status: number; location: string | null } {
  const asked = new URL(path, DOOR);
  if (asked.pathname === REGISTERING_PATH) {
    w.onSignIn();
    return w.signsIn ? { status: 303, location: asked.searchParams.get("redirect_to") ?? "/" } : { status: 200, location: null };
  }
  return { status: w.seats.has("administrators") || w.seats.has("managers") ? 200 : 404, location: null };
}

/** What a browser does with a link: follows the door's redirects and Gitea's to the last answer. */
async function open(w: World, link: string) {
  let path = link;
  const bounces: string[] = [];
  for (let hop = 0; hop < 20; hop++) {
    const door = await atTheDoor(w, path);
    if (door.location) {
      bounces.push(door.location);
      path = door.location;
      continue;
    }
    if (door.status !== 200) return { status: door.status, path, bounces };
    const page = atGitea(w, path);
    if (!page.location) return { status: page.status, path, bounces };
    path = page.location;
  }
  throw new Error(`still being redirected after 20 requests: ${bounces.join(", ")}`);
}

Deno.test("a first visit by a link lands on what it names, placed in the team the role warrants", async () => {
  for (const [role, team, other] of [["Administrator", "administrators", "managers"], ["Shopfloor_Manager", "managers", "administrators"]]) {
    const w = newcomer(role);
    const landed = await open(w, `${REPOSITORY}/wiki?x=1`);
    assert.equal(landed.status, 200, role);
    assert.equal(landed.path, `${REPOSITORY}/wiki?x=1&${BOUNCED_PARAM}=${w.login}`, role);
    assert.equal(landed.bounces.length, 1, role);
    assert.equal([w.seats.has(team), w.seats.has("readers"), w.seats.has(other)], [true, true, false], role);
  }
});

Deno.test("the second visit is served without a bounce", async () => {
  const w = newcomer("Administrator");
  await open(w, REPOSITORY);
  assert.equal(await open(w, REPOSITORY), { status: 200, path: REPOSITORY, bounces: [] });
});

Deno.test("a login that stays unregistered is let through after one bounce, not bounced again", async () => {
  const never = newcomer("Administrator", { registered: () => false });
  const landed = await open(never, REPOSITORY);
  assert.equal([landed.status, landed.path, landed.bounces.length], [404, `${REPOSITORY}?${BOUNCED_PARAM}=${never.login}`, 1]);
  const door = await atTheDoor(never, landed.path);
  assert.equal([door.status, door.body.placed, door.body.reason], [200, false, "not yet registered"]);

  const signInPage = newcomer("Administrator", { registered: () => false, signsIn: false });
  const stayed = await open(signInPage, REPOSITORY);
  assert.equal([stayed.status, stayed.path, stayed.bounces.length], [200, stayed.bounces[0], 1]);
});

Deno.test("one visit is bounced at most once, whatever Gitea answers", async () => {
  // Gitea's answers to "do you know this login?", every sequence of four, each repeated to the end.
  for (let pattern = 0; pattern < 16; pattern++) {
    let lookups = 0;
    const w = newcomer("Shopfloor_Manager", { registered: () => ((pattern >> (lookups++ % 4)) & 1) === 1 });
    const { bounces } = await open(w, REPOSITORY);
    assert.equal(bounces.length <= 1, true, `pattern ${pattern}: ${bounces.join(", ")}`);
  }
});

Deno.test("a registered login's page load is placed and let through, with no bounce", async () => {
  const w = newcomer("Administrator", { registered: () => true });
  const door = await atTheDoor(w, REPOSITORY);
  assert.equal([door.status, door.location, door.body.placed], [200, null, true]);
  assert.equal(w.seats.has("administrators"), true);
});

Deno.test("a request that is not a page load keeps its answer: let through, unplaced", async () => {
  const requests: [string, Asked][] = [
    ["/user/events", { headers: { "Sec-Fetch-Mode": "cors", Accept: "text/event-stream" } }],
    ["/repo/search?q=gateway", { headers: { "Sec-Fetch-Mode": "same-origin", Accept: "application/json" } }],
    [`${REPOSITORY}/issues/new`, { method: "POST" }],
    [REPOSITORY, { method: "HEAD" }],
    [REPOSITORY, { headers: {} }],
    [`${REGISTERING_PATH}?redirect_to=%2F`, {}],
    ["//evil.example/x", {}],
  ];
  for (const [path, asked] of requests) {
    const door = await atTheDoor(newcomer("Administrator"), path, asked);
    assert.equal([door.status, door.location, door.body.placed], [200, null, false], `${asked.method ?? "GET"} ${path}`);
  }
});

Deno.test("a role the forge does not admit is refused, never bounced", async () => {
  for (const role of ["Operator", "Auditor", null]) {
    for (const registered of [false, true]) {
      const w = newcomer(role, { registered: () => registered, seats: new Set(["managers", "readers"]) });
      const door = await atTheDoor(w, REPOSITORY);
      assert.equal([door.status, door.location], [403, null], `${role}, ${registered ? "registered" : "not registered"}`);
      if (registered) assert.equal([...w.seats], [], `${role} left every team`);
    }
  }
});

Deno.test("an ended session goes through the door's sign-out, whoever it was", async () => {
  const door = await atTheDoor(newcomer("Administrator", { sessionEnded: true }), REPOSITORY);
  assert.equal([door.status, door.location], [302, "/oauth2/signout"]);
});

Deno.test("a forge that does not answer, or none, is a 5xx the listener lets through, never a bounce", async () => {
  const down = await atTheDoor(newcomer("Administrator", { forgeDown: true }), REPOSITORY);
  assert.equal([down.status, down.location], [502, null]);
  const none = await atTheDoor(newcomer("Administrator"), REPOSITORY, { env: NO_FORGE });
  assert.equal([none.status, none.location], [503, null]);
});
