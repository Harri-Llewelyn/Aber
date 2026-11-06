import {
  afterFailure,
  backoffSeconds,
  cloudEvent,
  type Decision,
  deliver,
  type Deps,
  type Due,
  HOLD_SECONDS,
  hostAllowed,
  MAX_ATTEMPTS,
  post,
  type Recorded,
  signature,
  signedHeaders,
  subjectPath,
} from "./dispatch.ts";

// Local rather than an assertion library: a test import would enter deno.lock and the image's graph.
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    const [a, e] = [JSON.stringify(actual), JSON.stringify(expected)];
    if (a !== e) throw new Error(`${message ? `${message}: ` : ""}expected ${e}, got ${a}`);
  },
  ok(value: unknown, message = "") {
    if (!value) throw new Error(message || `expected a truthy value, got ${JSON.stringify(value)}`);
  },
};

/**
 * A key written as Standard Webhooks writes one, from plain words so it reads as the fixture it is.
 * The expected signature was computed apart from this code, with Node's crypto.createHmac over
 * "msg_test_vector.1614265330.{"test": 2432232314}"; the same layout reproduces the Standard
 * Webhooks specification's own example.
 */
const VECTOR = {
  key: `whsec_${btoa("aber-webhook-test-vector-key-0001")}`,
  id: "msg_test_vector",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  expected: "v1,mrsW7cO8Sf7h/9U6MOeH+aIk8oSsnAZUrGfWLCnH/QI=",
};

const URL_ = "https://hooks.example.net/services/receiver-path";
const DASHBOARD = "https://aber.example.net";

const ALERT = {
  id: "a0d17247-0000-4000-8000-0000000247a1",
  name: "Device Offline",
  severity: "critical",
  status: "firing",
  subject: { type: "device", id: "a0d17247-0000-4000-8000-0000000247d1", sparkplug_id: "dev0247000000000400080000", name: "Press 4" },
  starts_at: "2026-11-05T09:00:00+00:00",
  ends_at: null,
  summary: "Press 4 has not reported for 5 minutes.",
  labels: { alertname: "Device Offline", severity: "critical" },
  values: { A: 312, C: 1 },
};

function due(over: Partial<Due> = {}): Due {
  return {
    id: "a0d17247-0000-4000-8000-0000000247e1",
    event: "firing",
    channel: "webhook",
    attempts: 0,
    created_at: "2026-11-05T09:00:05+00:00",
    alert: ALERT,
    ...over,
  };
}

interface Harness {
  deps: Deps;
  recorded: Array<{ id: string } & Recorded>;
  posts: Array<{ url: string; init: RequestInit }>;
  decisions: string[];
}

/** A dispatcher with a fake database and a fake network. `answer` is what each post gets back. */
function harness(
  { decide = ["send"], answer = () => new Response("ok", { status: 200 }), hosts = ["hooks.example.net"], url = URL_ }:
    { decide?: Decision[]; answer?: (url: string, init: RequestInit) => Response | Promise<Response>; hosts?: string[]; url?: string | null } = {},
): Harness {
  const h: Harness = { recorded: [], posts: [], decisions: [], deps: null as unknown as Deps };
  const queue = [...decide];
  h.deps = {
    decide: (alertId, event, channel) => {
      h.decisions.push(`${alertId}:${event}:${channel}`);
      return Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0]);
    },
    record: (id, r) => {
      h.recorded.push({ id, ...r });
      return Promise.resolve();
    },
    destination: { url, signing_key: VECTOR.key, allowed_hosts: hosts },
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const target = String(input);
      h.posts.push({ url: target, init: init ?? {} });
      return Promise.resolve(answer(target, init ?? {}));
    }) as typeof fetch,
    now: () => new Date("2026-11-05T09:00:10Z"),
    source: DASHBOARD,
    dashboard: DASHBOARD,
  };
  return h;
}

Deno.test("the signature is Standard Webhooks' v1 HMAC-SHA256 of id.timestamp.body, against a known vector", async () => {
  assert.equal(await signature(VECTOR.key, VECTOR.id, VECTOR.timestamp, VECTOR.body), VECTOR.expected);
  // A key without the prefix is the same bytes.
  assert.equal(await signature(VECTOR.key.slice(6), VECTOR.id, VECTOR.timestamp, VECTOR.body), VECTOR.expected);
  const headers = await signedHeaders(VECTOR.key, VECTOR.id, VECTOR.timestamp, VECTOR.body);
  assert.equal(headers, {
    "Content-Type": "application/cloudevents+json; charset=utf-8",
    "webhook-id": VECTOR.id,
    "webhook-timestamp": "1614265330",
    "webhook-signature": VECTOR.expected,
  });
});

Deno.test("a firing alert is a CloudEvents 1.0 event in structured JSON, with a link to its subject", () => {
  assert.equal(cloudEvent(due(), DASHBOARD, DASHBOARD), {
    specversion: "1.0",
    id: "a0d17247-0000-4000-8000-0000000247e1",
    source: DASHBOARD,
    type: "aber.alert.firing",
    time: "2026-11-05T09:00:00.000Z",
    datacontenttype: "application/json",
    data: {
      alert_id: ALERT.id,
      name: "Device Offline",
      severity: "critical",
      subject: { type: "device", id: ALERT.subject.id, sparkplug_id: ALERT.subject.sparkplug_id, name: "Press 4" },
      starts_at: "2026-11-05T09:00:00.000Z",
      ends_at: null,
      summary: "Press 4 has not reported for 5 minutes.",
      labels: { alertname: "Device Offline", severity: "critical" },
      values: { A: 312, C: 1 },
      link: `${DASHBOARD}/devices?search=${ALERT.subject.id}`,
    },
  });
});

Deno.test("each event has its type and its time: resolved at the end, a reminder and a test when queued", () => {
  const resolved = cloudEvent(due({ event: "resolved", alert: { ...ALERT, status: "resolved", ends_at: "2026-11-05T09:30:00Z" } }), "urn:aber", null);
  assert.equal([resolved.type, resolved.time], ["aber.alert.resolved", "2026-11-05T09:30:00.000Z"]);
  assert.equal((resolved.data as { link: unknown }).link, null, "no dashboard address, no link");
  const reminder = cloudEvent(due({ event: "reminder" }), "urn:aber", DASHBOARD);
  assert.equal([reminder.type, reminder.time], ["aber.alert.reminder", "2026-11-05T09:00:05.000Z"]);
  const test = cloudEvent(due({ event: "test", alert: null }), "urn:aber", DASHBOARD);
  assert.equal([test.type, test.time, (test.data as { link: string }).link],
    ["aber.test", "2026-11-05T09:00:05.000Z", `${DASHBOARD}/settings/notifications`]);
});

Deno.test("a subject's link is the page routes.js links it on", () => {
  assert.equal(subjectPath({ type: "gateway", id: null, sparkplug_id: "gw line/4", name: null }), "/gateways?search=gw%20line%2F4");
  assert.equal(subjectPath({ type: "platform", id: null, sparkplug_id: null, name: null }), "/");
});

Deno.test("a sent message is posted once, signed, to the address, and recorded sent", async () => {
  const h = harness();
  assert.equal(await deliver(due(), h.deps), "sent");
  assert.equal(h.posts.length, 1);
  const { url, init } = h.posts[0];
  assert.equal(url, URL_);
  const headers = init.headers as Record<string, string>;
  const expected = await signature(VECTOR.key, "a0d17247-0000-4000-8000-0000000247e1", 1793869210, init.body as string);
  assert.equal([headers["webhook-id"], headers["webhook-timestamp"], headers["webhook-signature"]],
    ["a0d17247-0000-4000-8000-0000000247e1", "1793869210", expected]);
  assert.equal(JSON.parse(init.body as string).type, "aber.alert.firing");
  assert.equal(h.recorded, [{ id: "a0d17247-0000-4000-8000-0000000247e1", outcome: "sent", status: 200 }]);
});

Deno.test("an address whose host is not allowed is refused before anything is posted, and the log says why", async () => {
  const h = harness({ hosts: ["other.example.net"] });
  assert.equal(await deliver(due(), h.deps), "failed");
  assert.equal(h.posts.length, 0, "nothing posted");
  // The whole sentence, so the error names neither the address nor its host.
  assert.equal(h.recorded[0].error, "The webhook's host is not on its allowed hosts, so the message was refused.");
});

Deno.test("the allow-list matches a host exactly: no suffix, no prefix, any case", () => {
  assert.ok(hostAllowed("https://HOOKS.example.net:8443/x", ["hooks.example.net"]));
  assert.ok(!hostAllowed("https://evil-hooks.example.net/x", ["hooks.example.net"]));
  assert.ok(!hostAllowed("https://hooks.example.net.evil.test/x", ["hooks.example.net"]));
  assert.ok(!hostAllowed("https://user@evil.test/x", ["hooks.example.net"]));
  assert.ok(!hostAllowed("ftp://hooks.example.net/x", ["hooks.example.net"]));
  assert.ok(!hostAllowed("not a url", ["hooks.example.net"]));
});

Deno.test("a redirect is not followed: one post, redirect manual, and a failure that says so", async () => {
  const h = harness({ answer: () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.test/" } }) });
  assert.equal(await deliver(due(), h.deps), "failed");
  assert.equal(h.posts.length, 1, "posted once");
  assert.equal(h.posts[0].init.redirect, "manual");
  assert.equal(h.recorded[0].status, 302);
  assert.equal(h.recorded[0].error, "The receiver answered 302, a redirect, which is not followed.");
});

Deno.test("an answer outside 2xx, a timeout and an unreachable host are failures that never name the address", async () => {
  const rejected = harness({ answer: () => new Response("no", { status: 503 }) });
  await deliver(due(), rejected.deps);
  assert.equal([rejected.recorded[0].status, rejected.recorded[0].error], [503, "The receiver answered 503."]);

  const slow = await post(URL_, {}, "{}", ((_u: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch, 1500);
  assert.equal(slow, { ok: false, status: null, error: "The receiver did not answer within 2 seconds." });

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  try {
    const down = await post(URL_, {}, "{}", (() => Promise.reject(new TypeError(`error sending request for url (${URL_})`))) as typeof fetch);
    assert.equal(down.error, "The receiver could not be reached: the connection, the name lookup or TLS failed.");
  } finally {
    console.error = original;
  }
  assert.ok(errors.length === 1 && !errors[0].includes("receiver-path"), `the log redacts the path: ${errors[0]}`);
});

Deno.test("a failed message backs off, doubling from 30 seconds to an hour, and is dead after the tenth attempt", async () => {
  assert.equal([1, 2, 3, 4, 5, 6, 7, 8, 9].map(backoffSeconds), [30, 60, 120, 240, 480, 960, 1920, 3600, 3600]);
  const h = harness({ answer: () => new Response("down", { status: 500 }) });
  const row = due();
  const outcomes: string[] = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    outcomes.push(await deliver({ ...row, attempts: attempt }, h.deps));
  }
  assert.equal(outcomes, [...Array(MAX_ATTEMPTS - 1).fill("failed"), "dead"]);
  assert.equal(h.recorded.map((r) => r.retrySeconds ?? null), [30, 60, 120, 240, 480, 960, 1920, 3600, 3600, null]);
  assert.equal(h.posts.length, MAX_ATTEMPTS);
  // A test is tried once.
  assert.equal(afterFailure("test", 0), { outcome: "dead" });
});

Deno.test("a held message is not posted and waits a minute; decided again, it is sent", async () => {
  const h = harness({ decide: ["hold", "send"] });
  assert.equal(await deliver(due(), h.deps), "held");
  assert.equal(h.posts.length, 0);
  assert.equal(h.recorded[0], { id: due().id, outcome: "held", retrySeconds: HOLD_SECONDS });
  assert.equal(await deliver(due(), h.deps), "sent", "the hold has lifted");
  assert.equal(h.posts.length, 1);
  assert.equal(h.decisions, [`${ALERT.id}:firing:webhook`, `${ALERT.id}:firing:webhook`]);
});

Deno.test("a dropped message is recorded and never posted; a test is never decided", async () => {
  const dropped = harness({ decide: ["drop"] });
  assert.equal(await deliver(due({ event: "reminder" }), dropped.deps), "dropped");
  assert.equal([dropped.posts.length, dropped.recorded[0].outcome], [0, "dropped"]);

  const test = harness({ decide: ["drop"] });
  assert.equal(await deliver(due({ event: "test", alert: null }), test.deps), "sent");
  assert.equal(test.decisions, []);
  assert.equal(JSON.parse(test.posts[0].init.body as string).type, "aber.test");
});

Deno.test("no address or no key is a failure that names what is missing", async () => {
  const none = harness({ url: null });
  await deliver(due(), none.deps);
  assert.equal([none.posts.length, none.recorded[0].error], [0, "The webhook has no address set."]);

  const unsigned = harness();
  unsigned.deps.destination = { ...unsigned.deps.destination, signing_key: null };
  await deliver(due(), unsigned.deps);
  assert.equal([unsigned.posts.length, unsigned.recorded[0].error],
    [0, "The webhook has no signing key: issue one on the Settings page."]);
});
