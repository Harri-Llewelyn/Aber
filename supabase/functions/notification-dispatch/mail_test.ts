import { composeMessage, encodedWords, headerValue, mailbox, mailDate, oneLine, quotedPrintable } from "./mail.ts";

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

// The decoders below are written apart from the encoders, from the RFCs' rules, so a test checks
// the output against the rule and not against the code that made it.

/** RFC 2047: every encoded word's bytes, joined, as text. Fails on a word that is not UTF-8 base64. */
function decodeWords(value: string): string {
  const words = [...value.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)];
  const text = value.replace(/=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/g, "").replace(/\r\n /g, "");
  assert.equal(text, "", "nothing but encoded words and their folds");
  return words.map(([, b64]) => new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).join("");
}

/** RFC 2045's quoted-printable decoding, with soft line breaks. */
function decodeQp(value: string): string {
  const bytes: number[] = [];
  const joined = value.replace(/=\r\n/g, "");
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=") {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i));
    }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
}

const WELSH = "Mae’r Gwasg 4 yn ŵŷr: cyfnod â ê î ô û ŵ ŷ € \u{1F6A8}";

Deno.test("encoded words are UTF-8, base64, at most 75 characters, and never end inside a character", () => {
  const long = WELSH.repeat(5);
  const folded = encodedWords(long);
  for (const word of folded.split("\r\n ")) {
    assert.ok(word.length <= 75, `a word of ${word.length} characters`);
    assert.ok(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(word), word);
    // Decoding each word alone must succeed: a split inside a character would not be valid UTF-8.
    decodeWords(word);
  }
  assert.equal(decodeWords(folded), long);
});

Deno.test("a header value is left as written when it is printable ASCII, and folded at a space when long", () => {
  assert.equal(headerValue("Critical: Device Offline on Press 4"), "Critical: Device Offline on Press 4");
  const long = headerValue("word ".repeat(40).trim());
  for (const line of long.split("\r\n")) assert.ok(line.length <= 76, line);
  assert.equal(long.replace(/\r\n /g, " "), "word ".repeat(40).trim());
});

Deno.test("a header value with a non-ASCII character is encoded whole", () => {
  assert.equal(decodeWords(headerValue(WELSH)), WELSH);
  // deno-lint-ignore no-control-regex
  assert.ok(!/[^\x00-\x7f]/.test(headerValue(WELSH)));
});

Deno.test("a line break in a value cannot start another header", () => {
  const hostile = "Alert\r\nBcc: someone@example.net\nX-Other: 1";
  assert.equal(oneLine(hostile), "Alert Bcc: someone@example.net X-Other: 1");
  assert.ok(!headerValue(hostile).includes("\n"));
  const message = composeMessage({ from: { address: "a@example.net", name: hostile }, subject: hostile, body: "b", messageId: "i@example.net", date: new Date(0) });
  const head = message.split("\r\n\r\n")[0].split("\r\n");
  assert.ok(!head.some((l) => /^Bcc:/i.test(l)), "no header was injected");
  assert.ok(!head.some((l) => /^X-Other:/i.test(l)));
});

Deno.test("a mailbox quotes a plain name and encodes a Welsh one", () => {
  assert.equal(mailbox({ address: "aber@example.net" }), "<aber@example.net>");
  assert.equal(mailbox({ address: "aber@example.net", name: 'Aber "Alerts"' }), '"Aber \\"Alerts\\"" <aber@example.net>');
  const welsh = mailbox({ address: "aber@example.net", name: "Aber ŵ" });
  assert.ok(welsh.endsWith(" <aber@example.net>"));
  assert.equal(decodeWords(welsh.replace(" <aber@example.net>", "")), "Aber ŵ");
});

Deno.test("the date is RFC 5322's, in UTC", () => {
  assert.equal(mailDate(new Date("2026-11-09T09:05:07Z")), "Mon, 09 Nov 2026 09:05:07 +0000");
  assert.equal(mailDate(new Date("2026-01-01T00:00:00Z")), "Thu, 01 Jan 2026 00:00:00 +0000");
});

Deno.test("quoted-printable round-trips every kind of line, and no line is longer than 76", () => {
  const cases = [
    "plain ascii",
    "",
    "trailing space ",
    "trailing tab\t",
    "a = b and =3D literally",
    "tab\tinside and  double  spaces",
    "x".repeat(76),
    "x".repeat(77),
    "x".repeat(200),
    `${"x".repeat(74)}ŵ`,
    `${"x".repeat(73)}ŵŷ€\u{1F6A8}`,
    "ŵ".repeat(100),
    ".leading dot",
    "From the start",
    WELSH,
    `${WELSH}\n${WELSH} \n\n${"= ".repeat(60)}`,
  ];
  for (const input of cases) {
    const encoded = quotedPrintable(input);
    for (const line of encoded.split("\r\n")) assert.ok(line.length <= 76, `${line.length} characters: ${line}`);
    assert.ok(!/[^\x20-\x7e\r\n\t]/.test(encoded), "ASCII only");
    for (const line of encoded.split("\r\n")) assert.ok(!/[ \t]$/.test(line), "no trailing whitespace survives to be stripped");
    assert.equal(decodeQp(encoded), input.replace(/\r\n|\r/g, "\n").replace(/\n/g, "\r\n"), JSON.stringify(input));
  }
});

Deno.test("quoted-printable takes CR, LF and CRLF alike as a line end", () => {
  assert.equal(quotedPrintable("a\rb\nc\r\nd"), "a\r\nb\r\nc\r\nd");
});

Deno.test("a message has the headers a relay and a mail client expect, and a body that decodes", () => {
  const message = composeMessage({
    from: { address: "aber@example.net", name: "Aber" },
    subject: `Critical: ${WELSH}`,
    body: `${WELSH}\n.line with a dot\n\nLink: https://aber.example.net/devices?search=press4\n\n`,
    messageId: "alert-1.d2@aber.example.net",
    references: ["alert-1@aber.example.net"],
    date: new Date("2026-11-09T10:00:00Z"),
  });
  const split = message.indexOf("\r\n\r\n");
  const head = message.slice(0, split);
  const body = message.slice(split + 4);
  const lines = head.replace(/\r\n /g, " ").split("\r\n");
  const header = (name: string) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
  assert.equal(header("Date"), "Mon, 09 Nov 2026 10:00:00 +0000");
  assert.equal(header("From"), '"Aber" <aber@example.net>');
  assert.equal(header("To"), "undisclosed-recipients:;");
  assert.equal(header("Message-ID"), "<alert-1.d2@aber.example.net>");
  assert.equal(header("In-Reply-To"), "<alert-1@aber.example.net>");
  assert.equal(header("References"), "<alert-1@aber.example.net>");
  assert.equal(header("Auto-Submitted"), "auto-generated");
  assert.equal(header("MIME-Version"), "1.0");
  assert.equal(header("Content-Type"), "text/plain; charset=utf-8");
  assert.equal(header("Content-Transfer-Encoding"), "quoted-printable");
  assert.equal(decodeWords(header("Subject")!.replace(/ (=\?)/g, "$1")), `Critical: ${WELSH}`);
  assert.equal(decodeQp(body), `${WELSH}\r\n.line with a dot\r\n\r\nLink: https://aber.example.net/devices?search=press4\r\n`);
  assert.ok(message.endsWith("\r\n") && !message.endsWith("\r\n\r\n"));
  // deno-lint-ignore no-control-regex
  assert.ok(!/[^\x00-\x7f]/.test(message), "ASCII only");
});

Deno.test("a message that follows no other has no reply headers", () => {
  const message = composeMessage({ from: { address: "a@example.net" }, subject: "s", body: "b", messageId: "i@example.net", date: new Date(0) });
  assert.ok(!message.includes("In-Reply-To") && !message.includes("References"));
});
