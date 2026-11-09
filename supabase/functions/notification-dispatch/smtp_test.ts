import { composeMessage } from "./mail.ts";
import {
  certificateError,
  dotStuff,
  type Envelope,
  isSendableAddress,
  sendMessage,
  type SmtpConfig,
  SmtpError,
  type Socket,
  type Transport,
} from "./smtp.ts";

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

async function failure(work: Promise<unknown>): Promise<SmtpError> {
  try {
    await work;
  } catch (err) {
    if (err instanceof SmtpError) return err;
    throw err;
  }
  throw new Error("expected the send to fail");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One direction of a connection: bytes pushed in at one end come out of read() at the other. */
class Pipe {
  private queue: Uint8Array[] = [];
  private waiting: ((chunk: Uint8Array | null) => void) | null = null;
  closed = false;

  push(bytes: Uint8Array) {
    if (this.closed) return;
    if (this.waiting) {
      const wake = this.waiting;
      this.waiting = null;
      wake(bytes);
    } else {
      this.queue.push(bytes);
    }
  }

  close() {
    this.closed = true;
    this.waiting?.(null);
    this.waiting = null;
  }

  /** Puts back what a reader had no room for. */
  unshift(bytes: Uint8Array) {
    this.queue.unshift(bytes);
  }

  next(): Promise<Uint8Array | null> {
    const head = this.queue.shift();
    if (head) return Promise.resolve(head);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => (this.waiting = resolve));
  }
}

interface Relay {
  /** The reply to the greeting. */
  greeting: string;
  /** EHLO's reply lines, the code left off; `{tls}` lines show only once the connection is encrypted. */
  capabilities: (tls: boolean) => string[];
  /** A reply to put in place of the usual one, by command (or END, after the message's final dot); CLOSE drops the connection. */
  override: Record<string, string>;
  /** The reply to a RCPT, by address. */
  rcpt: (address: string) => string;
  /** Delivers the reply a byte at a time, so no reply arrives whole. */
  trickle: boolean;
  /** Says nothing after the greeting. */
  silent: boolean;
}

function relay(over: Partial<Relay> = {}): Relay {
  return {
    greeting: "220 relay.example.net ESMTP",
    capabilities: (tls) => ["relay.example.net hello", "SIZE 1000000", "8BITMIME", ...(tls ? ["AUTH PLAIN LOGIN"] : ["STARTTLS"])],
    override: {},
    rcpt: () => "250 2.1.5 Ok",
    trickle: false,
    silent: false,
    ...over,
  };
}

/** What the fake relay saw, and the connection the client got. */
interface Run {
  commands: string[];
  data: string | null;
  connects: { host: string; port: number; implicit: boolean; caCerts: string[] }[];
  upgrades: number;
  handshakes: number;
  transport: Transport;
}

function fakeRelay(behaviour: Relay, options: { tlsFails?: unknown } = {}): Run {
  const run: Run = { commands: [], data: null, connects: [], upgrades: 0, handshakes: 0, transport: null! };
  let tls = false;

  run.transport = {
    connect(host, port, implicit, caCerts) {
      run.connects.push({ host, port, implicit, caCerts });
      tls = implicit;
      const toClient = new Pipe();
      const toServer = new Pipe();
      void serve(toServer, toClient);
      const socket: Socket = {
        read: async (p) => {
          const chunk = await toClient.next();
          if (!chunk) return null;
          const n = Math.min(chunk.length, p.length);
          p.set(chunk.subarray(0, n));
          if (n < chunk.length) toClient.unshift(chunk.subarray(n));
          return n;
        },
        write: (p) => {
          toServer.push(p.slice());
          return Promise.resolve(p.length);
        },
        close: () => {
          toClient.close();
          toServer.close();
        },
        handshake: () => {
          run.handshakes += 1;
          return options.tlsFails ? Promise.reject(options.tlsFails) : Promise.resolve({});
        },
      };
      return Promise.resolve(socket);
    },
    startTls(socket) {
      if (options.tlsFails) return Promise.reject(options.tlsFails);
      run.upgrades += 1;
      tls = true;
      return Promise.resolve(socket);
    },
  };

  async function serve(input: Pipe, output: Pipe) {
    const say = (text: string) => {
      const bytes = encoder.encode(`${text.split("\n").join("\r\n")}\r\n`);
      if (behaviour.trickle) for (const b of bytes) output.push(Uint8Array.of(b));
      else output.push(bytes);
    };
    let pending = "";
    const line = async (): Promise<string | null> => {
      while (true) {
        const end = pending.indexOf("\r\n");
        if (end >= 0) {
          const out = pending.slice(0, end);
          pending = pending.slice(end + 2);
          return out;
        }
        const chunk = await input.next();
        if (!chunk) return null;
        pending += decoder.decode(chunk);
      }
    };

    say(behaviour.greeting);
    if (behaviour.silent) return;
    let stage = "";
    while (true) {
      const command = await line();
      if (command === null) return;
      const verb = command.split(" ")[0].toUpperCase();
      // A login's words are not recorded: the tests look for them in what the client reports.
      run.commands.push(stage !== "" ? "<login>" : verb === "AUTH" ? command.split(" ").slice(0, 2).join(" ") : command);
      const forced = behaviour.override[stage === "" ? verb : stage];
      if (forced === "CLOSE") {
        output.close();
        return;
      }
      if (stage === "login-user") {
        say(forced ?? "334 UGFzc3dvcmQ6");
        stage = "login-password";
      } else if (stage === "login-password") {
        say(forced ?? "235 2.7.0 Authenticated");
        stage = "";
      } else if (verb === "EHLO") {
        const lines = behaviour.capabilities(tls);
        say(forced ?? lines.map((l, i) => `250${i === lines.length - 1 ? " " : "-"}${l}`).join("\n"));
      } else if (verb === "HELO") {
        say(forced ?? "250 relay.example.net");
      } else if (verb === "STARTTLS") {
        say(forced ?? "220 2.0.0 Ready to start TLS");
      } else if (verb === "AUTH") {
        if (command.toUpperCase().startsWith("AUTH LOGIN")) {
          say(forced ?? "334 VXNlcm5hbWU6");
          stage = "login-user";
        } else {
          say(forced ?? "235 2.7.0 Authenticated");
        }
      } else if (verb === "MAIL") {
        say(forced ?? "250 2.1.0 Ok");
      } else if (verb === "RCPT") {
        say(forced ?? behaviour.rcpt(command.slice(command.indexOf("<") + 1, command.indexOf(">"))));
      } else if (verb === "DATA") {
        say(forced ?? "354 End data with <CR><LF>.<CR><LF>");
        if (forced && !forced.startsWith("354")) continue;
        let body = "";
        while (true) {
          const l = await line();
          if (l === null) return;
          if (l === ".") break;
          body += `${l.startsWith(".") ? l.slice(1) : l}\r\n`;
        }
        run.data = body;
        say(behaviour.override["END"] ?? "250 2.0.0 Ok: queued");
      } else if (verb === "QUIT") {
        say("221 2.0.0 Bye");
        return;
      } else {
        say("502 5.5.2 Command not recognized");
      }
    }
  }
  return run;
}

const CONFIG: SmtpConfig = { host: "relay.example.net", port: 587, user: "", password: "", helo: "aber.example.net", timeoutMs: 500 };
const ENVELOPE: Envelope = { from: "aber@example.net", to: ["alice@example.net", "bob@example.net"] };
const DATA = "Subject: Test\r\n\r\nHello\r\n";

function plain(login = true): SmtpConfig {
  return login ? { ...CONFIG, user: "aber", password: "not-a-real-password" } : CONFIG;
}

Deno.test("port 465 is TLS from the first byte and never sends STARTTLS", async () => {
  const run = fakeRelay(relay());
  const sent = await sendMessage({ ...plain(), port: 465, caCerts: ["a site certificate"] }, ENVELOPE, DATA, run.transport);
  assert.equal(run.connects, [{ host: "relay.example.net", port: 465, implicit: true, caCerts: ["a site certificate"] }]);
  assert.equal(run.handshakes, 1);
  assert.equal(run.upgrades, 0);
  assert.ok(!run.commands.includes("STARTTLS"));
  assert.equal(sent.accepted, ENVELOPE.to);
  assert.equal(run.data, DATA);
});

Deno.test("port 587 upgrades with STARTTLS, asks again for the capabilities and then logs in", async () => {
  const run = fakeRelay(relay());
  const sent = await sendMessage({ ...plain(), caCerts: ["a site certificate"] }, ENVELOPE, DATA, run.transport);
  assert.equal(run.commands, [
    "EHLO aber.example.net",
    "STARTTLS",
    "EHLO aber.example.net",
    "AUTH PLAIN",
    "MAIL FROM:<aber@example.net>",
    "RCPT TO:<alice@example.net>",
    "RCPT TO:<bob@example.net>",
    "DATA",
    "QUIT",
  ]);
  assert.equal(run.connects[0].implicit, false);
  assert.equal(run.upgrades, 1);
  assert.equal(run.handshakes, 1);
  assert.equal(sent, { accepted: ENVELOPE.to, refused: [] });
});

Deno.test("AUTH PLAIN carries the user and password as RFC 4616 writes them", async () => {
  let seen = "";
  const run = fakeRelay(relay());
  const inner = run.transport.connect;
  run.transport.connect = async (...args) => {
    const socket = await inner(...args);
    const write = socket.write;
    socket.write = (p) => {
      const text = decoder.decode(p);
      if (text.startsWith("AUTH PLAIN ")) seen = text;
      return write(p);
    };
    return socket;
  };
  await sendMessage({ ...plain(), user: "aber", password: "pass word" }, ENVELOPE, DATA, run.transport);
  assert.equal(seen, `AUTH PLAIN ${btoa("\0aber\0pass word")}\r\n`);
});

Deno.test("AUTH LOGIN is used when PLAIN is not offered, and its prompts are answered in turn", async () => {
  const run = fakeRelay(relay({ capabilities: (tls) => ["relay", ...(tls ? ["AUTH LOGIN"] : ["STARTTLS"])] }));
  await sendMessage(plain(), ENVELOPE, DATA, run.transport);
  assert.equal(run.commands.slice(3, 7), ["AUTH LOGIN", "<login>", "<login>", "MAIL FROM:<aber@example.net>"]);
});

Deno.test("a relay with no login and no TLS gets the message in the clear", async () => {
  const run = fakeRelay(relay({ capabilities: () => ["relay", "SIZE 1000000"] }));
  const sent = await sendMessage({ ...plain(false), port: 25 }, ENVELOPE, DATA, run.transport);
  assert.equal(sent.accepted, ENVELOPE.to);
  assert.equal(run.upgrades, 0);
  assert.ok(!run.commands.some((c) => c.startsWith("AUTH")));
});

Deno.test("a login is never sent over a connection the relay will not encrypt", async () => {
  const run = fakeRelay(relay({ capabilities: () => ["relay", "AUTH PLAIN LOGIN"] }));
  const err = await failure(sendMessage(plain(), ENVELOPE, DATA, run.transport));
  assert.equal(err.stage, "auth");
  assert.ok(!run.commands.some((c) => c.startsWith("AUTH")), "no AUTH command went out");
  assert.ok(!run.commands.some((c) => c.startsWith("MAIL")));
});

Deno.test("a login that the relay does not offer is refused before the envelope", async () => {
  const run = fakeRelay(relay({ capabilities: (tls) => ["relay", ...(tls ? [] : ["STARTTLS"])] }));
  const err = await failure(sendMessage(plain(), ENVELOPE, DATA, run.transport));
  assert.equal(err.stage, "auth");
  assert.ok(!run.commands.some((c) => c.startsWith("MAIL")));
});

Deno.test("a relay that knows only HELO is greeted with it", async () => {
  const run = fakeRelay(relay({ override: { EHLO: "502 5.5.1 EHLO not recognized" } }));
  const sent = await sendMessage(plain(false), ENVELOPE, DATA, run.transport);
  assert.equal(run.commands.slice(0, 2), ["EHLO aber.example.net", "HELO aber.example.net"]);
  assert.equal(sent.accepted, ENVELOPE.to);
});

Deno.test("a multi-line greeting and a reply that arrives a byte at a time are read whole", async () => {
  const run = fakeRelay(relay({ greeting: "220-relay.example.net\n220-ready for mail\n220 go ahead", trickle: true }));
  const sent = await sendMessage(plain(), ENVELOPE, DATA, run.transport);
  assert.equal(sent.accepted, ENVELOPE.to);
});

Deno.test("capability names are matched whatever their case", async () => {
  const run = fakeRelay(relay({ capabilities: (tls) => ["relay", ...(tls ? ["auth plain login", "size 100000"] : ["starttls"])] }));
  await sendMessage(plain(), ENVELOPE, DATA, run.transport);
  assert.equal(run.upgrades, 1);
  assert.ok(run.commands.includes("AUTH PLAIN"));
});

Deno.test("a leading dot is doubled on the wire and restored by the relay, and the message ends alone", () => {
  assert.equal(dotStuff("a\r\n.b\r\n..c\r\n.\r\nd"), "a\r\n..b\r\n...c\r\n..\r\nd\r\n.\r\n");
  assert.equal(dotStuff("line\nwith LF\rand CR\r\n\r\n"), "line\r\nwith LF\r\nand CR\r\n.\r\n");
});

Deno.test("dot-stuffed lines reach the relay as the message had them", async () => {
  const run = fakeRelay(relay());
  const data = "Subject: dots\r\n\r\n.starts with a dot\r\n..two\r\n.\r\nlast";
  await sendMessage(plain(), ENVELOPE, data, run.transport);
  assert.equal(run.data, `${data}\r\n`);
});

Deno.test("a message composed with Welsh text arrives as ASCII that decodes back to it", async () => {
  const run = fakeRelay(relay());
  const message = composeMessage({
    from: { address: "aber@example.net", name: "Aber" },
    subject: "Rhybudd: Gwasg 4 wedi stopio ŵŷ",
    body: "Mae’r peiriant yn ŵŷr.\n.dot line\n",
    messageId: "abc@example.net",
    date: new Date("2026-11-09T10:00:00Z"),
  });
  await sendMessage(plain(), ENVELOPE, message, run.transport);
  // deno-lint-ignore no-control-regex
  assert.ok(/^[\x00-\x7f]*$/.test(run.data ?? "é"), "everything on the wire is ASCII");
  assert.ok(run.data?.includes("\r\n..dot") === false, "the relay was handed the dot undoubled");
  assert.ok(run.data?.includes("=C5=B5"), "the body is quoted-printable UTF-8");
});

Deno.test("an unusable address is refused before any connection, so none can carry a command", async () => {
  const run = fakeRelay(relay());
  const bad = "x@example.net>\r\nRCPT TO:<evil@example.net";
  const err = await failure(sendMessage(plain(), { from: "aber@example.net", to: [bad] }, DATA, run.transport));
  assert.equal(err.stage, "address");
  assert.equal(run.connects.length, 0);
  const sent = await sendMessage(plain(), { from: "aber@example.net", to: [bad, "alice@example.net"] }, DATA, run.transport);
  assert.equal(sent.accepted, ["alice@example.net"]);
  assert.equal(sent.refused.map((r) => r.address), [bad]);
  assert.ok(!run.commands.some((c) => /evil/.test(c)));
  assert.equal((await failure(sendMessage(plain(), { from: "no at sign", to: ["a@b.c"] }, DATA, run.transport))).stage, "address");
});

Deno.test("which strings count as an address", () => {
  for (const ok of ["a@b.c", "first.last+tag@example.net", "o'brien@example.net", "pâr@example.net"]) {
    assert.ok(isSendableAddress(ok), ok);
  }
  for (const bad of ["", "a", "a@", "@b", "a b@c", "a@b@c", "<a@b>", "a@b\r\n", "a,b@c", '"a"@b', "a@b".padEnd(300, "x")]) {
    assert.ok(!isSendableAddress(bad), JSON.stringify(bad));
  }
});

Deno.test("a non-ASCII address needs SMTPUTF8, and asks for it", async () => {
  const without = fakeRelay(relay({ capabilities: () => ["relay"] }));
  const err = await failure(sendMessage(plain(false), { from: "aber@example.net", to: ["pâr@example.net"] }, DATA, without.transport));
  assert.equal(err.stage, "address");
  const withIt = fakeRelay(relay({ capabilities: () => ["relay", "SMTPUTF8"] }));
  await sendMessage(plain(false), { from: "aber@example.net", to: ["pâr@example.net"] }, DATA, withIt.transport);
  assert.ok(withIt.commands.some((c) => c.endsWith("> SMTPUTF8") && c.startsWith("MAIL")));
});

Deno.test("a message larger than the relay's SIZE is not sent", async () => {
  const run = fakeRelay(relay({ capabilities: (tls) => ["relay", "SIZE 10", ...(tls ? [] : ["STARTTLS"])] }));
  const err = await failure(sendMessage(plain(false), ENVELOPE, DATA, run.transport));
  assert.equal(err.code, 552);
  assert.ok(err.permanent);
  assert.ok(!run.commands.includes("DATA"));
});

Deno.test("each step's refusal is reported at its stage, with the relay's code and words", async () => {
  const cases: [string, Partial<Relay>, string, number, boolean][] = [
    ["a refused greeting", { greeting: "554 5.3.2 No service for you" }, "greeting", 554, true],
    ["a busy greeting", { greeting: "421 4.3.2 Try later" }, "greeting", 421, false],
    ["STARTTLS refused", { override: { STARTTLS: "454 4.7.0 TLS not available now" } }, "starttls", 454, false],
    ["a login refused", { override: { AUTH: "535 5.7.8 Credentials invalid" } }, "auth", 535, true],
    ["the sender refused", { override: { MAIL: "550 5.7.1 Sender not allowed" } }, "mail", 550, true],
    ["the sender deferred", { override: { MAIL: "451 4.3.0 Local error" } }, "mail", 451, false],
    ["every recipient refused", { rcpt: () => "550 5.1.1 No such user" }, "rcpt", 550, true],
    ["every recipient deferred", { rcpt: () => "450 4.2.0 Mailbox busy" }, "rcpt", 450, false],
    ["DATA refused", { override: { DATA: "554 5.5.1 No valid recipients" } }, "data", 554, true],
    ["the message refused after the dot", { override: { END: "554 5.7.1 Rejected as spam" } }, "end", 554, true],
    ["the message deferred after the dot", { override: { END: "452 4.3.1 Insufficient storage" } }, "end", 452, false],
  ];
  for (const [name, behaviour, stage, code, permanent] of cases) {
    const run = fakeRelay(relay(behaviour));
    const err = await failure(sendMessage(plain(), ENVELOPE, DATA, run.transport));
    assert.equal([err.stage, err.code, err.permanent], [stage, code, permanent], name);
    assert.ok(err.message.startsWith(String(code)), `${name}: the message leads with the code: ${err.message}`);
  }
});

Deno.test("a recipient refused while another is taken is reported, and the message still goes", async () => {
  const run = fakeRelay(relay({ rcpt: (a) => (a.startsWith("alice") ? "550 5.1.1 No such user" : "250 Ok") }));
  const sent = await sendMessage(plain(), ENVELOPE, DATA, run.transport);
  assert.equal(sent.accepted, ["bob@example.net"]);
  assert.equal(sent.refused.length, 1);
  assert.equal([sent.refused[0].address, sent.refused[0].code], ["alice@example.net", 550]);
  assert.equal(run.data, DATA);
});

Deno.test("a relay that never answers fails the step, and the connection is closed", async () => {
  const run = fakeRelay(relay({ silent: true }));
  const started = Date.now();
  const err = await failure(sendMessage({ ...plain(), timeoutMs: 50 }, ENVELOPE, DATA, run.transport));
  assert.equal(err.stage, "ehlo");
  assert.ok(!err.permanent);
  assert.ok(Date.now() - started < 1000);
});

Deno.test("the whole exchange is bounded, whatever each step is allowed", async () => {
  // A relay that answers the greeting at once and then says nothing; the step limit alone would allow 10 s.
  const run = fakeRelay(relay({ silent: true }));
  const started = Date.now();
  const err = await failure(sendMessage({ ...plain(), timeoutMs: 10_000, totalMs: 60 }, ENVELOPE, DATA, run.transport));
  assert.ok(!err.permanent);
  assert.ok(Date.now() - started < 1000);
});

Deno.test("a connection that drops mid-conversation is a failure to try again, not a refusal", async () => {
  const run = fakeRelay(relay({ override: { MAIL: "CLOSE" } }));
  const err = await failure(sendMessage(plain(false), ENVELOPE, DATA, run.transport));
  assert.equal(err.code, null);
  assert.ok(!err.permanent);
});

Deno.test("a reply that is not SMTP, or too long, is refused", async () => {
  const garbage = fakeRelay(relay({ greeting: "HTTP/1.1 400 Bad Request" }));
  assert.equal((await failure(sendMessage(plain(false), ENVELOPE, DATA, garbage.transport))).stage, "greeting");
  const long = fakeRelay(relay({ greeting: `220 ${"x".repeat(5000)}` }));
  assert.equal((await failure(sendMessage(plain(false), ENVELOPE, DATA, long.transport))).stage, "greeting");
});

Deno.test("a certificate the runtime refuses is named, on either kind of connection", async () => {
  const unknown = new Error("invalid peer certificate: UnknownIssuer");
  const implicit = fakeRelay(relay(), { tlsFails: unknown });
  const a = await failure(sendMessage({ ...plain(), port: 465 }, ENVELOPE, DATA, implicit.transport));
  assert.equal([a.stage, a.message], ["tls", "The relay's certificate was not issued by an authority this platform trusts."]);
  const starttls = fakeRelay(relay(), { tlsFails: new Error("invalid peer certificate: Expired") });
  const b = await failure(sendMessage(plain(), ENVELOPE, DATA, starttls.transport));
  assert.equal([b.stage, b.message], ["tls", "The relay's certificate has expired."]);
});

Deno.test("what the runtime says about a certificate is turned into a sentence", () => {
  const cases: [string, string | null][] = [
    ["InvalidData: invalid peer certificate: UnknownIssuer", "was not issued by an authority this platform trusts"],
    ["invalid peer certificate: NotValidForName", "is not valid for the relay's host name"],
    ["invalid peer certificate: NotValidForNameContext { expected: DnsName(\"x\"), presented: [] }", "is not valid for the relay's host name"],
    ["invalid peer certificate: Other(OtherError(CaUsedAsEndEntity))", "belongs to a certificate authority, which cannot also serve as the relay's own"],
    ["invalid peer certificate: ExpiredContext { time: 1, not_after: 0 }", "has expired"],
    ["invalid peer certificate: NotValidYet", "is not valid yet"],
    ["invalid peer certificate: BadSignature", "was not accepted"],
    ["connection reset by peer", null],
  ];
  for (const [said, expected] of cases) {
    const err = certificateError(new Error(said));
    assert.equal(err ? err.message : null, expected ? `The relay's certificate ${expected}.` : null, said);
  }
});

Deno.test("a name that does not resolve is a failure to connect, and says nothing of the address", async () => {
  const transport: Transport = {
    connect: () => Promise.reject(new Error("failed to lookup address information: Name or service not known")),
    startTls: () => Promise.reject(new Error("unused")),
  };
  const err = await failure(sendMessage(plain(), ENVELOPE, DATA, transport));
  assert.equal(err.stage, "connect");
  assert.equal(err.message, "The relay could not be reached: the connection or the name lookup failed.", "the sentence names no host");
});

Deno.test("the password appears in nothing the client reports", async () => {
  const run = fakeRelay(relay({ override: { AUTH: "535 5.7.8 Credentials invalid" } }));
  const err = await failure(sendMessage({ ...plain(), password: "very-secret-words" }, ENVELOPE, DATA, run.transport));
  assert.ok(!err.message.includes("very-secret-words"));
  assert.ok(!JSON.stringify(run.commands).includes("very-secret-words"));
});
