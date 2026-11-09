/**
 * A small SMTP client: one connection, one message, however many recipients. It speaks what a site's
 * relay needs and no more: implicit TLS on port 465, STARTTLS elsewhere when the relay offers it,
 * AUTH PLAIN or LOGIN, and a multi-line reply anywhere a reply can come. Written against
 * `Deno.connect`, `Deno.connectTls` and `Deno.startTls`, so the functions image carries no mail
 * library. The transport is a parameter, so the tests drive the protocol with no socket.
 *
 * It mirrors GoTrue's reading of the same settings (port 465 is TLS from the first byte; anything
 * else upgrades when it can) and never sends a password in the clear.
 */

/** The part of a connection this client uses; Deno's TcpConn and TlsConn both have it. */
export interface Socket {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
  /** A TLS connection's handshake, which Deno runs on first use unless asked for here. */
  handshake?(): Promise<unknown>;
}

export interface Transport {
  /** Opens the connection; `implicit` is TLS from the first byte. */
  connect(host: string, port: number, implicit: boolean, caCerts: string[]): Promise<Socket>;
  /** Upgrades an open connection to TLS, checking the certificate against `host`. */
  startTls(socket: Socket, host: string, caCerts: string[]): Promise<Socket>;
}

export const denoTransport: Transport = {
  connect: (hostname, port, implicit, caCerts) =>
    implicit ? Deno.connectTls({ hostname, port, caCerts }) : Deno.connect({ hostname, port, transport: "tcp" }),
  startTls: (socket, hostname, caCerts) => Deno.startTls(socket as Deno.TcpConn, { hostname, caCerts }),
};

/** What the runtime's certificate errors come to, as a site's administrator can act on them. */
const CERTIFICATE_REASONS: [string, string][] = [
  ["UnknownIssuer", "was not issued by an authority this platform trusts"],
  ["NotValidForName", "is not valid for the relay's host name"],
  ["CaUsedAsEndEntity", "belongs to a certificate authority, which cannot also serve as the relay's own"],
  ["Expired", "has expired"],
  ["NotValidYet", "is not valid yet"],
];

/** An SmtpError for a certificate the runtime refused, or null when the failure is something else. */
export function certificateError(err: unknown): SmtpError | null {
  const found = /invalid peer certificate: (?:Other\(OtherError\()?(\w+)/.exec(err instanceof Error ? err.message : String(err));
  if (!found) return null;
  const reason = CERTIFICATE_REASONS.find(([key]) => found[1].startsWith(key))?.[1] ?? "was not accepted";
  return new SmtpError("tls", `The relay's certificate ${reason}.`);
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** Empty for a relay that takes no login. */
  user: string;
  password: string;
  /** PEM certificates trusted for the relay's certificate, on top of the runtime's own roots. */
  caCerts?: string[];
  /** What EHLO says this client is. */
  helo?: string;
  /** How long one connect, reply or TLS handshake may take. */
  timeoutMs?: number;
  /** How long the whole exchange may take, which the runtime's own 60-second limit bounds from above. */
  totalMs?: number;
}

export interface Envelope {
  from: string;
  to: string[];
}

export type Stage = "address" | "connect" | "greeting" | "ehlo" | "starttls" | "tls" | "auth" | "mail" | "rcpt" | "data" | "end";

/** `code` is the relay's reply code, or null for a failure of the connection itself. */
export class SmtpError extends Error {
  constructor(readonly stage: Stage, message: string, readonly code: number | null = null) {
    super(message);
    this.name = "SmtpError";
  }
  /** A 5xx reply is final: sending the same message again will be refused the same way. */
  get permanent(): boolean {
    return this.code !== null && this.code >= 500;
  }
}

export interface Refusal {
  address: string;
  code: number;
  message: string;
}

export interface Sent {
  accepted: string[];
  /** Recipients the relay refused while taking the others; the message still went to `accepted`. */
  refused: Refusal[];
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_TOTAL_MS = 15_000;
/** A longer reply line than this is not SMTP (RFC 5321 allows 512). */
const MAX_REPLY_LINE = 2048;
const MAX_REPLY_LINES = 100;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Reply {
  code: number;
  lines: string[];
}

function text(reply: Reply): string {
  return reply.lines.join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Rejects after `ms`, first running `onTimeout` (it closes the socket, so a read waiting on it ends too). */
function within<T>(work: Promise<T>, ms: number, stage: Stage, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new SmtpError(stage, "The relay did not answer in time."));
    }, ms);
  });
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** What a failed read or write means: a refused certificate says so, anything else is a dropped connection. */
function lost(stage: Stage, err: unknown): SmtpError {
  if (err instanceof SmtpError) return err;
  return certificateError(err) ?? new SmtpError(stage, "The connection to the relay was lost.");
}

/** One connection's reading side: bytes in, lines and replies out. */
class Channel {
  private buffer = new Uint8Array(0);

  /** `wait()` is how long the next step may take: one step's limit, or what is left of the whole. */
  constructor(public socket: Socket, private readonly wait: () => number) {}

  /** After STARTTLS: the new connection, with nothing left over from the old one. */
  replace(socket: Socket) {
    this.socket = socket;
    this.buffer = new Uint8Array(0);
  }

  private async line(stage: Stage): Promise<string> {
    const chunk = new Uint8Array(4096);
    while (true) {
      const end = this.buffer.indexOf(10);
      if (end >= 0) {
        const raw = this.buffer.subarray(0, end);
        this.buffer = this.buffer.slice(end + 1);
        return decoder.decode(raw).replace(/\r$/, "");
      }
      if (this.buffer.length > MAX_REPLY_LINE) throw new SmtpError(stage, "The relay sent a reply line that is too long.");
      let n: number | null;
      try {
        n = await within(this.socket.read(chunk), this.wait(), stage, () => this.close());
      } catch (err) {
        throw lost(stage, err);
      }
      if (n === null) throw new SmtpError(stage, "The relay closed the connection.");
      const merged = new Uint8Array(this.buffer.length + n);
      merged.set(this.buffer);
      merged.set(chunk.subarray(0, n), this.buffer.length);
      this.buffer = merged;
    }
  }

  /** A reply: `250-first`, `250-second`, `250 last`. The code of the last line is the reply's. */
  async reply(stage: Stage): Promise<Reply> {
    const lines: string[] = [];
    let code = 0;
    for (let i = 0; i < MAX_REPLY_LINES; i++) {
      const line = await this.line(stage);
      const match = /^(\d{3})([ -]|$)(.*)$/.exec(line);
      if (!match) throw new SmtpError(stage, "The relay sent a reply that is not SMTP.");
      code = Number(match[1]);
      lines.push(match[3]);
      if (match[2] !== "-") return { code, lines };
    }
    throw new SmtpError(stage, "The relay sent a reply of too many lines.");
  }

  async send(data: string | Uint8Array, stage: Stage): Promise<void> {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    try {
      await within(
        (async () => {
          let at = 0;
          while (at < bytes.length) at += await this.socket.write(bytes.subarray(at));
        })(),
        this.wait(),
        stage,
        () => this.close(),
      );
    } catch (err) {
      throw lost(stage, err);
    }
  }

  /** One command and its reply; a code outside `ok` is the relay's refusal. */
  async command(line: string, stage: Stage, ok: number[]): Promise<Reply> {
    await this.send(`${line}\r\n`, stage);
    return this.expect(await this.reply(stage), stage, ok);
  }

  expect(reply: Reply, stage: Stage, ok: number[]): Reply {
    if (!ok.includes(reply.code)) throw new SmtpError(stage, `${reply.code} ${text(reply)}`.trim(), reply.code);
    return reply;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

/** The extensions a 250 reply to EHLO lists, upper-cased: `AUTH PLAIN LOGIN` is one entry per word group. */
function capabilities(reply: Reply): Map<string, string> {
  const caps = new Map<string, string>();
  for (const line of reply.lines.slice(1)) {
    const [name, ...rest] = line.trim().split(/\s+/);
    if (name) caps.set(name.toUpperCase(), rest.join(" ").toUpperCase());
  }
  return caps;
}

// deno-lint-ignore no-control-regex
const ADDRESS = /^[^\s<>"\\,;:()[\]\x00-\x1f\x7f]+@[^\s<>"\\,;:()[\]\x00-\x1f\x7f]+$/;

/** Whether the address is one this client will put in a command: no space, bracket, quote or control. */
export function isSendableAddress(address: string): boolean {
  return address.length <= 254 && ADDRESS.test(address) && address.indexOf("@") === address.lastIndexOf("@");
}

function ascii(address: string): boolean {
  // deno-lint-ignore no-control-regex
  return /^[\x00-\x7f]*$/.test(address);
}

/** One message's data as it goes on the wire: CRLF line ends, a leading dot doubled, then the dot. */
export function dotStuff(data: string): string {
  const lines = data.replace(/\r\n|\r|\n/g, "\r\n").replace(/(\r\n)+$/, "").split("\r\n");
  return lines.map((l) => (l.startsWith(".") ? `.${l}` : l)).join("\r\n") + "\r\n.\r\n";
}

/**
 * Sends one message. `data` is the complete message, headers and body, with every non-ASCII
 * character already encoded (mail.ts). Throws an SmtpError when the relay or the connection stops
 * the message from reaching anyone; a recipient refused while others are taken is in `refused`.
 */
export async function sendMessage(
  config: SmtpConfig,
  envelope: Envelope,
  data: string,
  transport: Transport = denoTransport,
): Promise<Sent> {
  const stepMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endsAt = Date.now() + (config.totalMs ?? DEFAULT_TOTAL_MS);
  const wait = () => Math.max(Math.min(stepMs, endsAt - Date.now()), 1);
  const caCerts = config.caCerts ?? [];
  const helo = config.helo || "localhost";
  const implicit = config.port === 465;

  if (!isSendableAddress(envelope.from)) throw new SmtpError("address", "The sender's address is not usable.");
  const to = envelope.to.filter((a) => isSendableAddress(a));
  const refused: Refusal[] = envelope.to
    .filter((a) => !isSendableAddress(a))
    .map((address) => ({ address, code: 0, message: "Not a usable address." }));
  if (!to.length) throw new SmtpError("address", "No recipient has a usable address.");

  let socket: Socket;
  try {
    const opening = transport.connect(config.host, config.port, implicit, caCerts);
    // A connection that opens after the wait is over is closed, not left to the runtime.
    socket = await within(opening, wait(), "connect", () => void opening.then((late) => late.close(), () => {}));
  } catch (err) {
    if (err instanceof SmtpError) throw err;
    // Deno checks a certificate while it connects, in some versions, so this may be the TLS handshake.
    throw certificateError(err) ?? new SmtpError("connect", "The relay could not be reached: the connection or the name lookup failed.");
  }
  if (implicit) socket = await handshake(socket, wait);

  const channel = new Channel(socket, wait);
  try {
    channel.expect(await channel.reply("greeting"), "greeting", [220]);

    let caps = await ehlo(channel, helo);
    let secure = implicit;
    if (!implicit && caps.has("STARTTLS")) {
      await channel.command("STARTTLS", "starttls", [220]);
      let upgraded: Socket;
      try {
        upgraded = await within(transport.startTls(channel.socket, config.host, caCerts), wait(), "tls", () => channel.close());
      } catch (err) {
        throw lost("tls", err);
      }
      channel.replace(await handshake(upgraded, wait));
      secure = true;
      // The capabilities from before the upgrade are void (RFC 3207).
      caps = await ehlo(channel, helo);
    }

    if (config.user) {
      if (!secure) {
        throw new SmtpError("auth", "The relay offers no TLS, so the password was not sent: it would cross the network in the clear.");
      }
      await authenticate(channel, caps, config.user, config.password);
    }

    const size = Number((caps.get("SIZE") ?? "").split(" ")[0]);
    if (size > 0 && data.length > size) {
      throw new SmtpError("mail", "The message is larger than the relay accepts.", 552);
    }
    const utf8 = [envelope.from, ...to].some((a) => !ascii(a));
    if (utf8 && !caps.has("SMTPUTF8")) {
      throw new SmtpError("address", "An address has non-ASCII characters and the relay does not take SMTPUTF8.");
    }
    await channel.command(`MAIL FROM:<${envelope.from}>${utf8 ? " SMTPUTF8" : ""}`, "mail", [250]);

    const accepted: string[] = [];
    let lastRefusal: SmtpError | null = null;
    for (const address of to) {
      await channel.send(`RCPT TO:<${address}>\r\n`, "rcpt");
      const reply = await channel.reply("rcpt");
      if (reply.code === 250 || reply.code === 251) {
        accepted.push(address);
      } else {
        refused.push({ address, code: reply.code, message: text(reply) });
        lastRefusal = new SmtpError("rcpt", `${reply.code} ${text(reply)}`, reply.code);
      }
    }
    if (!accepted.length) throw lastRefusal ?? new SmtpError("rcpt", "No recipient was accepted.");

    await channel.command("DATA", "data", [354]);
    await channel.send(dotStuff(data), "end");
    channel.expect(await channel.reply("end"), "end", [250]);

    // Best effort: the message is accepted whether or not the relay says goodbye.
    try {
      await channel.send("QUIT\r\n", "end");
    } catch {
      // Ignored.
    }
    return { accepted, refused };
  } finally {
    channel.close();
  }
}

/** Runs a TLS connection's handshake now, so a certificate the runtime refuses is reported as that. */
async function handshake(socket: Socket, wait: () => number): Promise<Socket> {
  if (!socket.handshake) return socket;
  try {
    await within(socket.handshake(), wait(), "tls", () => socket.close());
    return socket;
  } catch (err) {
    socket.close();
    throw err instanceof SmtpError ? err : certificateError(err) ?? new SmtpError("tls", "The TLS handshake with the relay failed.");
  }
}

async function ehlo(channel: Channel, helo: string): Promise<Map<string, string>> {
  await channel.send(`EHLO ${helo}\r\n`, "ehlo");
  const reply = await channel.reply("ehlo");
  if (reply.code === 250) return capabilities(reply);
  // An old relay that does not know EHLO: HELO, with no extensions to offer.
  if (reply.code >= 500) {
    await channel.command(`HELO ${helo}`, "ehlo", [250]);
    return new Map();
  }
  throw new SmtpError("ehlo", `${reply.code} ${text(reply)}`.trim(), reply.code);
}

function b64(value: string): string {
  let binary = "";
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** AUTH PLAIN when the relay offers it, LOGIN otherwise. The login never reaches an error message. */
async function authenticate(channel: Channel, caps: Map<string, string>, user: string, password: string) {
  const methods = (caps.get("AUTH") ?? "").split(/\s+/);
  if (!caps.has("AUTH")) throw new SmtpError("auth", "The relay offers no login, but one is set.");
  if (methods.includes("PLAIN")) {
    await channel.command(`AUTH PLAIN ${b64(`\0${user}\0${password}`)}`, "auth", [235]);
  } else if (methods.includes("LOGIN")) {
    await channel.command("AUTH LOGIN", "auth", [334]);
    await channel.command(b64(user), "auth", [334]);
    await channel.command(b64(password), "auth", [235]);
  } else {
    throw new SmtpError("auth", "The relay's login methods are not PLAIN or LOGIN.");
  }
}
