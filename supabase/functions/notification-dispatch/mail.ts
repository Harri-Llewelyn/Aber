/**
 * An email message as text: the headers, with every non-ASCII character in an encoded word, and a
 * plain-text body in quoted-printable. Fields in, bytes out; nothing here opens a connection.
 */

const encoder = new TextEncoder();

export interface Mailbox {
  address: string;
  name?: string;
}

export interface Message {
  from: Mailbox;
  subject: string;
  body: string;
  /** Without the angle brackets. */
  messageId: string;
  /** Message ids, without the angle brackets, of the messages this one follows in a thread. */
  references?: string[];
  date: Date;
}

/** A header's value on one line: a line break or control character in it would end the header. */
export function oneLine(value: string): string {
  // deno-lint-ignore no-control-regex
  return value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}

function isAscii(value: string): boolean {
  // deno-lint-ignore no-control-regex
  return /^[\x00-\x7f]*$/.test(value);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** The most UTF-8 bytes one encoded word carries: 36 bytes are 48 base64 characters, a 60-character word. */
const WORD_BYTES = 36;

/**
 * RFC 2047 encoded words (UTF-8, base64), joined by a fold. A word never ends inside a multi-byte
 * character, so each decodes on its own.
 */
export function encodedWords(value: string): string {
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (chunk.length) words.push(`=?UTF-8?B?${base64(Uint8Array.from(chunk))}?=`);
    chunk = [];
  };
  for (const char of value) {
    const bytes = encoder.encode(char);
    if (chunk.length + bytes.length > WORD_BYTES) flush();
    chunk.push(...bytes);
  }
  flush();
  return words.join("\r\n ");
}

/** A header's value: as written when it is printable ASCII, folded at a space, else encoded words. */
export function headerValue(value: string): string {
  const line = oneLine(value);
  if (!isAscii(line)) return encodedWords(line);
  const folded: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    if (current && current.length + 1 + word.length > 72) {
      folded.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  folded.push(current);
  return folded.join("\r\n ");
}

/** `"Name" <address>`, the name encoded when it has non-ASCII characters. */
export function mailbox(box: Mailbox): string {
  const name = box.name ? oneLine(box.name) : "";
  if (!name) return `<${box.address}>`;
  if (!isAscii(name)) return `${encodedWords(name)} <${box.address}>`;
  return `"${name.replace(/(["\\])/g, "\\$1")}" <${box.address}>`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 5322's date, in UTC. */
export function mailDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[date.getUTCDay()]}, ${p(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} +0000`;
}

const HEX = "0123456789ABCDEF";

/**
 * Quoted-printable (RFC 2045): lines of at most 76 characters, a soft break (`=`) where one is
 * cut, a trailing space or tab written as =20 or =09 so the relay cannot strip it, and every byte
 * of a multi-byte character written out. Line ends in the input may be LF, CR or CRLF.
 */
export function quotedPrintable(body: string): string {
  const out: string[] = [];
  for (const line of body.replace(/\r\n|\r/g, "\n").split("\n")) {
    const bytes = encoder.encode(line);
    const tokens = Array.from(bytes, (b, i) => {
      const keep = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && i < bytes.length - 1);
      return keep ? String.fromCharCode(b) : `=${HEX[b >> 4]}${HEX[b & 15]}`;
    });
    let current = "";
    tokens.forEach((token, i) => {
      const limit = i === tokens.length - 1 ? 76 : 75;
      if (current.length + token.length > limit) {
        out.push(`${current}=`);
        current = "";
      }
      current += token;
    });
    out.push(current);
  }
  return out.join("\r\n");
}

/**
 * The whole message. `To` is the group `undisclosed-recipients:;` because the relay is told each
 * recipient in the envelope and none should see another's address. `Auto-Submitted` marks it as
 * machine-made, so a person's out-of-office reply does not answer an alert.
 */
export function composeMessage(message: Message): string {
  const headers: [string, string][] = [
    ["Date", mailDate(message.date)],
    ["From", mailbox(message.from)],
    ["To", "undisclosed-recipients:;"],
    ["Subject", headerValue(message.subject)],
    ["Message-ID", `<${message.messageId}>`],
  ];
  if (message.references?.length) {
    const ids = message.references.map((id) => `<${id}>`).join(" ");
    headers.push(["In-Reply-To", `<${message.references[message.references.length - 1]}>`], ["References", ids]);
  }
  headers.push(
    ["Auto-Submitted", "auto-generated"],
    ["X-Auto-Response-Suppress", "All"],
    ["MIME-Version", "1.0"],
    ["Content-Type", "text/plain; charset=utf-8"],
    ["Content-Transfer-Encoding", "quoted-printable"],
  );
  return `${headers.map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n${quotedPrintable(message.body.replace(/\s+$/, ""))}\r\n`;
}
