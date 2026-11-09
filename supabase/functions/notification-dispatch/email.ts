/**
 * The email channel's side of notification-dispatch: the relay as the environment states it, the
 * words of one message, and one send with its outcome in the dispatcher's terms. The protocol is
 * smtp.ts and the message's encoding is mail.ts; the queue, the decision and the retries are
 * dispatch.ts's, shared with the webhook.
 */
import type { AlertSnapshot, Due } from "./dispatch.ts";
import { composeMessage } from "./mail.ts";
import { type Envelope, isSendableAddress, type Sent, type SmtpConfig, SmtpError } from "./smtp.ts";

/** The relay, read from the variables GoTrue's SMTP settings come from (supabaseAuth.smtp). */
export interface EmailSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  /** The sender's address, supabaseAuth.smtp.from. */
  from: string;
  senderName: string;
  /** Certificates for a relay whose certificate a private authority signed. */
  caCerts: string[];
  /** What EHLO names this host. */
  helo: string;
}

/** What one send came to. `error` is in the dispatcher's words and holds no address. */
export interface EmailResult {
  ok: boolean;
  /** The relay's reply code: 250 for a send, the refusal's otherwise, null for a connection. */
  status: number | null;
  error: string | null;
  /** The relay refused the message itself, so another attempt would be refused the same way. */
  final: boolean;
  accepted: number;
  refused: number;
}

export type SendMessage = (config: SmtpConfig, envelope: Envelope, data: string) => Promise<Sent>;

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The host a dashboard address names, or null. An IP address is written as a literal, as EHLO wants. */
function heloFor(dashboard: string | null, from: string): string {
  try {
    if (dashboard) {
      const host = new URL(dashboard).hostname;
      if (host) return host.includes(":") && !host.startsWith("[") ? `[IPv6:${host}]` : host;
    }
  } catch {
    // Falls through to the sender's domain.
  }
  const domain = from.split("@")[1];
  return domain || "localhost";
}

/** The relay's settings from a lookup of environment variables, which a test supplies. */
export function emailSettingsFrom(env: (name: string) => string | undefined, dashboard: string | null): EmailSettings {
  const port = Number(env("SMTP_PORT"));
  const from = (env("SMTP_ADMIN_EMAIL") ?? "").trim();
  return {
    host: (env("SMTP_HOST") ?? "").trim(),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 587,
    user: env("SMTP_USER") ?? "",
    password: env("SMTP_PASS") ?? "",
    from,
    senderName: (env("SMTP_SENDER_NAME") ?? "").trim() || "Aber",
    caCerts: (env("SMTP_CA_PEM") ?? "").match(PEM) ?? [],
    helo: heloFor(dashboard, from),
  };
}

/**
 * Why email cannot send at all, in words for the delivery log and the Settings page, or null. The
 * relay is the one GoTrue reads, so a site that sends password resets has it already.
 */
export function relayProblem(settings: EmailSettings): string | null {
  if (!settings.host) {
    return "No mail relay is set up: the site's supabaseAuth.smtp.host is empty, and it is the relay the password-reset mail uses too.";
  }
  if (!isSendableAddress(settings.from)) {
    return "No sender address is set: the site's supabaseAuth.smtp.from is empty or is not an email address.";
  }
  return null;
}

/** An address in a relay's words is the person's, not the log's: it is replaced before it is kept. */
export function withoutAddresses(text: string): string {
  return text.replace(/<[^<>\s]*@[^<>\s]*>/g, "<address>").replace(/[^\s<>"',;:()[\]]+@[^\s<>"',;:()[\]]+/g, "<address>");
}

const SEVERITIES: Record<string, string> = { critical: "Critical", warning: "Warning", info: "Info" };
const HEADLINES: Record<string, string> = { firing: "is firing", resolved: "has resolved", reminder: "is still firing" };
const SUBJECT_EVENTS: Record<string, string> = { firing: "firing", resolved: "resolved", reminder: "reminder" };

// deno-lint-ignore no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/g;

/** Text from an alert, which a person or a rule wrote: one line, no control character in it, and not unbounded. */
function clean(value: unknown, max = 300): string {
  const text = String(value ?? "").replace(CONTROL, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function at(value: string | null | undefined): string {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return clean(value ?? "unknown");
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function span(from: string, to: string | null): string | null {
  if (!to) return null;
  const minutes = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 1) return "under a minute";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const part = (n: number, unit: string) => (n ? `${n} ${unit}${n === 1 ? "" : "s"}` : "");
  return [part(days, "day"), part(hours, "hour"), days ? "" : part(mins, "minute")].filter(Boolean).join(" ");
}

function number(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Number(value.toPrecision(8))) : clean(value, 40);
}

/** What the alert is about, for the subject and the "Where" line. */
function where(alert: AlertSnapshot): { name: string; kind: string } {
  const subject = alert.subject;
  const name = clean(subject.name || subject.sparkplug_id || "", 120);
  if (subject.type === "device" || subject.type === "gateway") return { name, kind: subject.type };
  if (subject.type === "service_identity") return { name: name || "a machine identity", kind: "machine identity" };
  return { name: name || "the platform", kind: "" };
}

/** The address the alert counter opens for this alert, under the dashboard's own. */
function linkTo(alert: AlertSnapshot, dashboard: string | null, path: (s: AlertSnapshot["subject"]) => string): string | null {
  return dashboard ? `${dashboard}${path(alert.subject)}` : null;
}

export interface Content {
  subject: string;
  body: string;
}

/**
 * One message's subject and plain-text body, from fields and no template: the severity, the alert's
 * name and what it is about, the event, when, the values and labels the rule carried, and the link.
 * English only. `path` is dispatch.ts's subjectPath, passed in so the two modules need not import
 * each other.
 */
export function emailContent(
  due: Due,
  dashboard: string | null,
  path: (s: AlertSnapshot["subject"]) => string,
  notificationsPath: string,
): Content {
  if (due.event === "test" || !due.alert) {
    const link = dashboard ? `\n\nThe settings: ${dashboard}${notificationsPath}` : "";
    return {
      subject: "[Aber] A test email",
      body: "This is a test from Aber's Settings page. Nothing is firing.\n\n" +
        "If you can read it, the mail relay accepted it and Aber can email you about alerts." + link,
    };
  }
  const alert = due.alert;
  const place = where(alert);
  const severity = SEVERITIES[alert.severity] ?? clean(alert.severity, 20);
  const name = clean(alert.name, 160);
  const subject = `[Aber] ${severity}: ${name}${place.name ? ` - ${place.name}` : ""} (${SUBJECT_EVENTS[due.event] ?? due.event})`;

  const lines: string[] = [`${name} ${HEADLINES[due.event] ?? due.event}.`, ""];
  lines.push(`Severity: ${severity}`);
  lines.push(`Where:    ${place.name}${place.kind ? ` (${place.kind})` : ""}`);
  lines.push(`Since:    ${at(alert.starts_at)}`);
  if (due.event === "resolved") {
    const lasted = span(alert.starts_at, alert.ends_at);
    lines.push(`Resolved: ${at(alert.ends_at ?? due.created_at)}${lasted ? `, after ${lasted}` : ""}`);
  } else if (due.event === "reminder") {
    const lasted = span(alert.starts_at, due.created_at);
    if (lasted) lines.push(`Firing for ${lasted} so far.`);
  }
  if (alert.summary) lines.push(`What:     ${clean(alert.summary, 500)}`);

  const values = Object.entries(alert.values ?? {}).slice(0, 20);
  if (values.length) {
    lines.push("", "Values:", ...values.map(([k, v]) => `  ${clean(k, 60)}: ${number(v)}`));
  }
  const labels = Object.entries(alert.labels ?? {}).slice(0, 20);
  if (labels.length) {
    lines.push("", "Labels:", ...labels.map(([k, v]) => `  ${clean(k, 60)}: ${clean(v, 120)}`));
  }
  const link = linkTo(alert, dashboard, path);
  if (link) lines.push("", "Open it in Aber:", link);
  lines.push(
    "",
    "-- ",
    "You are told because your role is on the site's email list for alerts (Settings > Notifications).",
    due.event === "resolved"
      ? "This is the last message about this occurrence."
      : "Acknowledging the alert in Aber stops these messages until it fires again.",
  );
  return { subject, body: lines.join("\n") };
}

/** The ids a message and its thread carry: a firing message is the thread's root. */
function messageIds(due: Due, domain: string): { id: string; references: string[] } {
  if (!due.alert) return { id: `test-${due.id}@${domain}`, references: [] };
  const root = `alert-${due.alert.id}.firing@${domain}`;
  if (due.event === "firing") return { id: root, references: [] };
  return { id: `alert-${due.alert.id}.${due.event}.${due.id}@${domain}`, references: [root] };
}

/** A relay's 4xx or 5xx, or a failure to reach it, as a sentence for the log. */
function describe(err: SmtpError): string {
  return err.code === null ? err.message : `The relay answered: ${withoutAddresses(err.message)}`;
}

/** The stages at which a 5xx is about this message, so sending it again would be refused the same way. */
const MESSAGE_STAGES = new Set(["address", "mail", "rcpt", "data", "end"]);

/**
 * One send to `people`. A relay that takes some addresses and refuses others has sent the message:
 * the refusals are counted and noted, since sending again would repeat it to the people it reached.
 */
export async function sendEmail(
  settings: EmailSettings,
  due: Due,
  people: string[],
  content: Content,
  send: SendMessage,
  now: Date,
): Promise<EmailResult> {
  const domain = settings.from.split("@")[1] ?? "localhost";
  const ids = messageIds(due, domain);
  const data = composeMessage({
    from: { address: settings.from, name: settings.senderName },
    subject: content.subject,
    body: content.body,
    messageId: ids.id,
    references: ids.references,
    date: now,
  });
  try {
    const sent = await send(
      {
        host: settings.host,
        port: settings.port,
        user: settings.user,
        password: settings.password,
        caCerts: settings.caCerts,
        helo: settings.helo,
        timeoutMs: 10_000,
        totalMs: 15_000,
      },
      { from: settings.from, to: people },
      data,
    );
    const refused = sent.refused.length;
    const note = refused
      ? `The relay refused ${refused} of ${people.length} address${people.length === 1 ? "" : "es"}: ` +
        withoutAddresses(sent.refused[0].code ? `${sent.refused[0].code} ${sent.refused[0].message}` : sent.refused[0].message)
      : null;
    return { ok: true, status: 250, error: note, final: false, accepted: sent.accepted.length, refused };
  } catch (err) {
    if (!(err instanceof SmtpError)) {
      console.error(`notification-dispatch: an email could not be sent: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, status: null, error: "The message could not be sent to the relay.", final: false, accepted: 0, refused: 0 };
    }
    return {
      ok: false,
      status: err.code,
      error: describe(err),
      final: err.permanent && MESSAGE_STAGES.has(err.stage),
      accepted: 0,
      refused: 0,
    };
  }
}

/** The Settings page's answer to "can this site send email": the relay and the sender, not the roles. */
export function relayStatus(settings: EmailSettings): { available: boolean; reason: string | null } {
  const reason = relayProblem(settings);
  return { available: reason === null, reason };
}
