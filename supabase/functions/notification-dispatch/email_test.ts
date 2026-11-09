import { backoffSeconds, type Decision, deliver, type Deps, type Due, type Recorded, subjectPath } from "./dispatch.ts";
import { type EmailSettings, emailContent, emailSettingsFrom, relayProblem, relayStatus, sendEmail, withoutAddresses } from "./email.ts";
import { type Envelope, type Sent, type SmtpConfig, SmtpError } from "./smtp.ts";

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

const DASHBOARD = "https://aber.example.net";

const ALERT = {
  id: "a0d17262-0000-4000-8000-0000000262a1",
  name: "Device Offline",
  severity: "critical",
  status: "firing",
  subject: { type: "device", id: "a0d17262-0000-4000-8000-0000000262d1", sparkplug_id: "dev0262000000000400080000", name: "Press 4" },
  starts_at: "2026-11-09T09:00:00+00:00",
  ends_at: null,
  summary: "Press 4 has not reported for 5 minutes.",
  labels: { alertname: "Device Offline", severity: "critical" },
  values: { A: 312, C: 1.5 },
};

const SETTINGS: EmailSettings = {
  host: "relay.example.net",
  port: 587,
  user: "aber",
  password: "not-a-real-password",
  from: "aber@example.net",
  senderName: "Aber",
  caCerts: [],
  helo: "aber.example.net",
};

function due(over: Partial<Due> = {}): Due {
  return {
    id: "a0d17262-0000-4000-8000-0000000262e1",
    event: "firing",
    channel: "email",
    attempts: 0,
    created_at: "2026-11-09T09:00:05+00:00",
    alert: ALERT,
    ...over,
  };
}

const content = (d: Due, dashboard: string | null = DASHBOARD) => emailContent(d, dashboard, subjectPath, "/settings/notifications");

Deno.test("the relay and the sender are read from the variables GoTrue's SMTP settings become", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  const empty = emailSettingsFrom(env({}), DASHBOARD);
  assert.equal([empty.host, empty.port, empty.user, empty.password, empty.from, empty.senderName, empty.caCerts],
    ["", 587, "", "", "", "Aber", []]);
  const set = emailSettingsFrom(env({
    SMTP_HOST: " mail.example.net ", SMTP_PORT: "465", SMTP_USER: "aber", SMTP_PASS: "p w", SMTP_ADMIN_EMAIL: "aber@example.net",
    SMTP_SENDER_NAME: "Aber (Plant 2)",
  }), DASHBOARD);
  assert.equal([set.host, set.port, set.user, set.password, set.from, set.senderName],
    ["mail.example.net", 465, "aber", "p w", "aber@example.net", "Aber (Plant 2)"]);
  for (const bad of ["", "0", "70000", "ssl", "587.5", "-1"]) {
    assert.equal(emailSettingsFrom(env({ SMTP_PORT: bad }), DASHBOARD).port, 587, `port ${JSON.stringify(bad)}`);
  }
});

Deno.test("EHLO names the dashboard's host, an address literal for an IP, else the sender's domain", () => {
  const helo = (dashboard: string | null, from = "aber@example.net") =>
    emailSettingsFrom((n) => ({ SMTP_ADMIN_EMAIL: from } as Record<string, string>)[n], dashboard).helo;
  assert.equal(helo("https://aber.example.net"), "aber.example.net");
  assert.equal(helo("http://10.0.0.7:8080"), "10.0.0.7");
  assert.equal(helo("https://[fd00::7]"), "[fd00::7]");
  assert.equal(helo(null), "example.net");
  assert.equal(helo("not a url"), "example.net");
  assert.equal(helo(null, ""), "localhost");
});

Deno.test("a private authority's certificates are split, one string each, from one variable", () => {
  const one = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
  const two = "-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----";
  const settings = emailSettingsFrom((n) => (n === "SMTP_CA_PEM" ? `${one}\n\n${two}\n` : undefined), DASHBOARD);
  assert.equal(settings.caCerts, [one, two]);
  assert.equal(emailSettingsFrom((n) => (n === "SMTP_CA_PEM" ? "not a certificate" : undefined), DASHBOARD).caCerts, []);
});

Deno.test("email cannot send without a relay or a sender, and the sentence says which and where it is set", () => {
  assert.equal(relayProblem(SETTINGS), null);
  assert.ok(relayProblem({ ...SETTINGS, host: "" })?.includes("supabaseAuth.smtp.host"));
  assert.ok(relayProblem({ ...SETTINGS, from: "" })?.includes("supabaseAuth.smtp.from"));
  assert.ok(relayProblem({ ...SETTINGS, from: "Aber <aber@example.net>" })?.includes("supabaseAuth.smtp.from"));
  assert.equal(relayStatus(SETTINGS), { available: true, reason: null });
  assert.equal(relayStatus({ ...SETTINGS, host: "" }).available, false);
  assert.ok(typeof relayStatus({ ...SETTINGS, host: "" }).reason === "string");
});

Deno.test("a firing alert's email names the severity, the alert, where, when, the values, the labels and the link", () => {
  const { subject, body } = content(due());
  assert.equal(subject, "[Aber] Critical: Device Offline - Press 4 (firing)");
  const lines = body.split("\n");
  assert.equal(lines[0], "Device Offline is firing.");
  for (const expected of [
    "Severity: Critical",
    "Where:    Press 4 (device)",
    "Since:    2026-11-09 09:00 UTC",
    "What:     Press 4 has not reported for 5 minutes.",
    "  A: 312",
    "  C: 1.5",
    "  alertname: Device Offline",
    `${DASHBOARD}/devices?search=${ALERT.subject.id}`,
  ]) assert.ok(lines.includes(expected), `a line reads ${JSON.stringify(expected)}; the body is:\n${body}`);
  assert.ok(body.includes("Open it in Aber:"));
  assert.ok(body.includes("Acknowledging the alert in Aber stops these messages"));
});

Deno.test("a resolve says when and after how long, and a reminder how long it has been firing", () => {
  const resolved = content(due({ event: "resolved", alert: { ...ALERT, status: "resolved", ends_at: "2026-11-09T11:05:00+00:00" } }));
  assert.equal(resolved.subject, "[Aber] Critical: Device Offline - Press 4 (resolved)");
  assert.ok(resolved.body.startsWith("Device Offline has resolved."));
  assert.ok(resolved.body.includes("Resolved: 2026-11-09 11:05 UTC, after 2 hours 5 minutes"), resolved.body);
  assert.ok(resolved.body.includes("This is the last message about this occurrence."));
  const reminder = content(due({ event: "reminder", created_at: "2026-11-09T21:00:00+00:00" }));
  assert.equal(reminder.subject, "[Aber] Critical: Device Offline - Press 4 (reminder)");
  assert.ok(reminder.body.startsWith("Device Offline is still firing."));
  assert.ok(reminder.body.includes("Firing for 12 hours so far."), reminder.body);
});

Deno.test("a gateway, the platform and a machine identity are named for what they are", () => {
  const gateway = content(due({ alert: { ...ALERT, subject: { type: "gateway", id: "g-1", sparkplug_id: null, name: "Edge 2" } } }));
  assert.ok(gateway.body.includes("Where:    Edge 2 (gateway)"));
  assert.ok(gateway.body.includes(`${DASHBOARD}/gateways?search=g-1`));
  const platform = content(due({ alert: { ...ALERT, name: "Audit Trail Partitions Falling Behind", subject: { type: "platform", id: null, sparkplug_id: null, name: null } } }));
  assert.equal(platform.subject, "[Aber] Critical: Audit Trail Partitions Falling Behind - the platform (firing)");
  assert.ok(platform.body.includes(`\n${DASHBOARD}/\n`), "the link is the dashboard itself");
  const identity = content(due({ alert: { ...ALERT, subject: { type: "service_identity", id: "p-1", sparkplug_id: null, name: "MCP client" } } }));
  assert.ok(identity.body.includes("Where:    MCP client (machine identity)"));
});

Deno.test("with no dashboard address there is no link, and a test says it is a test", () => {
  assert.ok(!content(due(), null).body.includes("Open it in Aber"));
  const test = content(due({ event: "test", alert: null }));
  assert.equal(test.subject, "[Aber] A test email");
  assert.ok(test.body.includes("Nothing is firing."));
  assert.ok(test.body.includes(`${DASHBOARD}/settings/notifications`));
  assert.ok(!content(due({ event: "test", alert: null }), null).body.includes("http"));
});

Deno.test("text an alert carries cannot add a line, a header or a control character to the message", () => {
  const hostile = { ...ALERT, name: "Offline\r\nBcc: x@example.net", summary: `bell\x07 and nul\x00 ${"x".repeat(900)}`, labels: { "a\nb": "c\rd" } };
  const { subject, body } = content(due({ alert: hostile }));
  assert.ok(!/[\r\n]/.test(subject), "the subject is one line");
  // deno-lint-ignore no-control-regex
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(body), "no control character in the body");
  assert.ok(body.split("\n").every((l) => l.length < 600), "a long summary is cut");
});

Deno.test("a relay's words lose every address before they are kept", () => {
  assert.equal(withoutAddresses("550 5.1.1 <bob@example.net>: Recipient address rejected"), "550 5.1.1 <address>: Recipient address rejected");
  assert.equal(withoutAddresses("550 bob@example.net does not exist; alice@example.net neither"), "550 <address> does not exist; <address> neither");
  assert.equal(withoutAddresses("452 4.2.2 Mailbox full"), "452 4.2.2 Mailbox full");
});

interface Sends {
  configs: SmtpConfig[];
  envelopes: Envelope[];
  data: string[];
  send: (config: SmtpConfig, envelope: Envelope, data: string) => Promise<Sent>;
}

function relay(answer: (envelope: Envelope) => Sent | Error = (e) => ({ accepted: e.to, refused: [] })): Sends {
  const sends: Sends = {
    configs: [], envelopes: [], data: [],
    send: (config, envelope, data) => {
      sends.configs.push(config);
      sends.envelopes.push(envelope);
      sends.data.push(data);
      const result = answer(envelope);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  return sends;
}

const NOW = new Date("2026-11-09T09:00:10Z");
const PEOPLE = ["alice@example.net", "bob@example.net"];

Deno.test("one email is one send to every address, with a message the thread can follow", async () => {
  const sends = relay();
  const firing = await sendEmail(SETTINGS, due(), PEOPLE, content(due()), sends.send, NOW);
  assert.equal(firing, { ok: true, status: 250, error: null, final: false, accepted: 2, refused: 0 });
  assert.equal(sends.envelopes[0], { from: "aber@example.net", to: PEOPLE });
  assert.equal([sends.configs[0].host, sends.configs[0].port, sends.configs[0].user, sends.configs[0].helo, sends.configs[0].timeoutMs, sends.configs[0].totalMs],
    ["relay.example.net", 587, "aber", "aber.example.net", 10_000, 15_000]);
  assert.ok(sends.data[0].includes(`Message-ID: <alert-${ALERT.id}.firing@example.net>`));
  assert.ok(!sends.data[0].includes("In-Reply-To"));
  assert.ok(sends.data[0].includes("To: undisclosed-recipients:;"), "no recipient sees another's address");
  assert.ok(!sends.data[0].includes("alice@example.net"), "the addresses are the envelope's alone");
  await sendEmail(SETTINGS, due({ event: "resolved" }), PEOPLE, content(due({ event: "resolved" })), sends.send, NOW);
  assert.ok(sends.data[1].includes(`References: <alert-${ALERT.id}.firing@example.net>`));
  assert.ok(sends.data[1].includes(`In-Reply-To: <alert-${ALERT.id}.firing@example.net>`));
});

Deno.test("an address the relay refused is counted and noted without the address, and the message still counts as sent", async () => {
  const sends = relay((e) => ({
    accepted: [e.to[1]],
    refused: [{ address: e.to[0], code: 550, message: "5.1.1 <alice@example.net>: Recipient address rejected" }],
  }));
  const result = await sendEmail(SETTINGS, due(), PEOPLE, content(due()), sends.send, NOW);
  assert.equal([result.ok, result.accepted, result.refused], [true, 1, 1]);
  assert.equal(result.error, "The relay refused 1 of 2 addresses: 550 5.1.1 <address>: Recipient address rejected");
});

Deno.test("a relay's refusal of the message itself is final, and one of the login or the connection is not", async () => {
  const cases: [SmtpError, boolean][] = [
    [new SmtpError("rcpt", "550 5.1.1 No such user", 550), true],
    [new SmtpError("end", "554 5.7.1 Rejected as spam", 554), true],
    [new SmtpError("data", "554 No valid recipients", 554), true],
    [new SmtpError("mail", "550 5.7.1 Sender not allowed", 550), true],
    [new SmtpError("rcpt", "451 4.7.1 Try again later", 451), false],
    [new SmtpError("auth", "535 5.7.8 Credentials invalid", 535), false],
    [new SmtpError("tls", "The relay's certificate has expired."), false],
    [new SmtpError("connect", "The relay could not be reached: the connection or the name lookup failed."), false],
  ];
  for (const [error, final] of cases) {
    const result = await sendEmail(SETTINGS, due(), PEOPLE, content(due()), relay(() => error).send, NOW);
    assert.equal([result.ok, result.final, result.status], [false, final, error.code], error.message);
  }
});

Deno.test("what the log keeps of a failure is the relay's words with no address, or ours with none to hide", async () => {
  const refused = await sendEmail(SETTINGS, due(), PEOPLE, content(due()),
    relay(() => new SmtpError("rcpt", "550 5.1.1 <bob@example.net>: Recipient address rejected", 550)).send, NOW);
  assert.equal(refused.error, "The relay answered: 550 5.1.1 <address>: Recipient address rejected");
  const down = await sendEmail(SETTINGS, due(), PEOPLE, content(due()),
    relay(() => new SmtpError("connect", "The relay could not be reached: the connection or the name lookup failed.")).send, NOW);
  assert.equal(down.error, "The relay could not be reached: the connection or the name lookup failed.");
  const odd = await sendEmail(SETTINGS, due(), PEOPLE, content(due()), relay(() => new Error("boom relay.example.net alice@example.net")).send, NOW);
  assert.equal(odd.error, "The message could not be sent to the relay.");
});

interface Run {
  deps: Deps;
  recorded: Array<{ id: string } & Recorded>;
  decided: string[];
  asked: string[];
  sends: Sends;
}

function run(
  { decide = ["send"] as Decision[], people = PEOPLE, settings = SETTINGS, answer }:
    { decide?: Decision[]; people?: string[]; settings?: EmailSettings; answer?: (e: Envelope) => Sent | Error } = {},
): Run {
  const r: Run = { recorded: [], decided: [], asked: [], sends: relay(answer), deps: null as unknown as Deps };
  const queue = [...decide];
  r.deps = {
    decide: (alertId, event, channel) => {
      r.decided.push(`${alertId}:${event}:${channel}`);
      return Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0]);
    },
    record: (id, rec) => {
      r.recorded.push({ id, ...rec });
      return Promise.resolve();
    },
    destination: { url: null, signing_key: null, allowed_hosts: [] },
    fetch: (() => Promise.reject(new Error("an email is never posted"))) as typeof fetch,
    now: () => NOW,
    source: DASHBOARD,
    dashboard: DASHBOARD,
    email: {
      settings,
      recipients: (id) => {
        r.asked.push(id);
        return Promise.resolve(people);
      },
      send: r.sends.send,
    },
  };
  return r;
}

Deno.test("a queued email is decided on its own channel, sent to the people found now, and recorded with their count", async () => {
  const r = run();
  assert.equal(await deliver(due(), r.deps), "sent");
  assert.equal(r.decided, [`${ALERT.id}:firing:email`]);
  assert.equal(r.asked, [due().id]);
  assert.equal(r.sends.envelopes[0].to, PEOPLE);
  assert.equal(r.recorded, [{ id: due().id, outcome: "sent", status: 250, error: null, recipients: 2, refused: 0 }]);
  assert.ok(JSON.stringify(r.recorded).indexOf("example.net") === -1, "no address reaches the log");
});

Deno.test("an email that no longer applies is dropped and never resolves its people or touches the relay", async () => {
  const r = run({ decide: ["drop"] });
  assert.equal(await deliver(due(), r.deps), "dropped");
  assert.equal([r.asked.length, r.sends.envelopes.length], [0, 0]);
  assert.equal(r.recorded, [{ id: due().id, outcome: "dropped" }]);
});

Deno.test("an email held for a suppression window waits a minute and is decided again", async () => {
  const r = run({ decide: ["hold", "send"] });
  assert.equal(await deliver(due(), r.deps), "held");
  assert.equal(r.recorded[0], { id: due().id, outcome: "held", retrySeconds: 60 });
  assert.equal(r.sends.envelopes.length, 0);
  assert.equal(await deliver(due(), r.deps), "sent");
});

Deno.test("with nobody to tell, an alert's email is dropped and a test says there is no address", async () => {
  const none = run({ people: [] });
  assert.equal(await deliver(due(), none.deps), "dropped");
  assert.equal(none.sends.envelopes.length, 0);
  const test = run({ people: [] });
  assert.equal(await deliver(due({ event: "test", alert: null }), test.deps), "dead");
  assert.ok(String(test.recorded[0].error).includes("no address"));
  assert.equal(test.decided, [], "a test is not decided");
});

Deno.test("no relay is a final answer in words, not ten retries, and the relay is not asked for people", async () => {
  const r = run({ settings: { ...SETTINGS, host: "" } });
  assert.equal(await deliver(due(), r.deps), "dead");
  assert.ok(String(r.recorded[0].error).includes("supabaseAuth.smtp.host"));
  assert.equal(r.asked.length, 0);
  const test = run({ settings: { ...SETTINGS, host: "" } });
  assert.equal(await deliver(due({ event: "test", alert: null }), test.deps), "dead");
});

Deno.test("a relay that is down is retried on the webhook's backoff, to a dead letter after the tenth", async () => {
  const down = new SmtpError("connect", "The relay could not be reached: the connection or the name lookup failed.");
  for (let attempts = 0; attempts < 9; attempts++) {
    const r = run({ answer: () => down });
    assert.equal(await deliver(due({ attempts }), r.deps), "failed");
    assert.equal(r.recorded[0].retrySeconds, backoffSeconds(attempts + 1));
  }
  const last = run({ answer: () => down });
  assert.equal(await deliver(due({ attempts: 9 }), last.deps), "dead");
});

Deno.test("a refusal of the message is dead at once, and a test is tried once", async () => {
  const refused = run({ answer: () => new SmtpError("end", "554 5.7.1 Rejected as spam", 554) });
  assert.equal(await deliver(due(), refused.deps), "dead");
  assert.equal(refused.recorded[0].status, 554);
  const test = run({ answer: () => new SmtpError("auth", "535 5.7.8 Credentials invalid", 535) });
  assert.equal(await deliver(due({ event: "test", alert: null }), test.deps), "dead");
});

Deno.test("a send the relay part refused is recorded sent with its counts and its note", async () => {
  const r = run({
    answer: (e) => ({ accepted: [e.to[1]], refused: [{ address: e.to[0], code: 550, message: "5.1.1 <alice@example.net>: rejected" }] }),
  });
  assert.equal(await deliver(due(), r.deps), "sent");
  assert.equal(r.recorded[0], {
    id: due().id, outcome: "sent", status: 250,
    error: "The relay refused 1 of 2 addresses: 550 5.1.1 <address>: rejected", recipients: 1, refused: 1,
  });
});

Deno.test("a webhook message is still posted, not emailed, when the dispatcher can do both", async () => {
  const r = run();
  const posts: string[] = [];
  r.deps.destination = { url: "https://hooks.example.net/x", signing_key: "whsec_" + btoa("not-a-real-key-not-a-real-key-00"), allowed_hosts: ["hooks.example.net"] };
  r.deps.fetch = ((input: string | URL | Request) => {
    posts.push(String(input));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  assert.equal(await deliver(due({ channel: "webhook" }), r.deps), "sent");
  assert.equal([posts.length, r.sends.envelopes.length, r.asked.length], [1, 0, 0]);
  assert.equal(r.recorded[0].recipients, undefined, "a webhook row keeps no counts");
});
