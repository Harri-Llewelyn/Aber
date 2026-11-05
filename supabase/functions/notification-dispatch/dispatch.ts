/**
 * What notification-dispatch does with one queued message, kept free of the database client so the
 * tests can drive it: the send decision, the allow-list, the CloudEvents envelope, the Standard
 * Webhooks signature, the post itself and the backoff. index.ts holds the pass around it.
 */

/** Posts per message before it is dead, and the backoff between them (supabase/README.md, 0247). */
export const MAX_ATTEMPTS = 10;
/** A test is tried once: the Administrator who sent it is waiting for the answer. */
export const TEST_MAX_ATTEMPTS = 1;
export const BASE_DELAY_SECONDS = 30;
export const MAX_DELAY_SECONDS = 3600;
/** How long a held message waits before it is decided again: the sweep's own minute. */
export const HOLD_SECONDS = 60;
/** How long a receiver has to answer. */
export const TIMEOUT_MS = 10_000;

export type Event = "firing" | "resolved" | "reminder" | "test";
export type Decision = "send" | "hold" | "drop";
export type Outcome = "sent" | "dropped" | "held" | "failed" | "dead";

/** The occurrence a message is about, as notification_deliveries_due() returns it. */
export interface AlertSnapshot {
  id: string;
  name: string;
  severity: string;
  status: string;
  subject: { type: string; id: string | null; sparkplug_id: string | null; name: string | null };
  starts_at: string;
  ends_at: string | null;
  summary: string | null;
  labels: Record<string, string> | null;
  values: Record<string, number> | null;
}

/** One due row. `alert` is null for a test. */
export interface Due {
  id: string;
  event: Event;
  channel: string;
  attempts: number;
  created_at: string;
  alert: AlertSnapshot | null;
}

/** What notification_webhook_destination() returns. */
export interface Destination {
  url: string | null;
  signing_key: string | null;
  allowed_hosts: string[];
}

export interface Recorded {
  outcome: Outcome;
  retrySeconds?: number;
  status?: number | null;
  error?: string | null;
}

export interface Deps {
  /** platform_alert_send_decision(), asked just before the send. */
  decide(alertId: string, event: Event, channel: string): Promise<Decision>;
  /** record_notification_delivery(). */
  record(id: string, result: Recorded): Promise<void>;
  destination: Destination;
  fetch: typeof fetch;
  now(): Date;
  /** The CloudEvents `source`: the dashboard's address, or urn:aber without one. */
  source: string;
  /** The dashboard's address, for each message's link; null leaves the link out. */
  dashboard: string | null;
  timeoutMs?: number;
}

/** The wait after a message's `attempt`-th failed post: 30 s, doubling, at most an hour. */
export function backoffSeconds(attempt: number): number {
  return Math.min(BASE_DELAY_SECONDS * 2 ** Math.max(attempt - 1, 0), MAX_DELAY_SECONDS);
}

/** A failed post is retried after its backoff, or dead once it was the last attempt allowed. */
export function afterFailure(event: Event, attemptsBefore: number): Pick<Recorded, "outcome" | "retrySeconds"> {
  const attempt = attemptsBefore + 1;
  const max = event === "test" ? TEST_MAX_ATTEMPTS : MAX_ATTEMPTS;
  return attempt >= max ? { outcome: "dead" } : { outcome: "failed", retrySeconds: backoffSeconds(attempt) };
}

/** The host a URL names, lower-cased, or null when it is not an http or https URL. */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Whether the URL's host is on the list, exactly: no wildcard, and no suffix match. */
export function hostAllowed(url: string, hosts: readonly string[]): boolean {
  const host = hostOf(url);
  return host !== null && hosts.some((h) => typeof h === "string" && h.toLowerCase() === host);
}

/** Where the dashboard shows an alert's subject, as routes.js's deviceUrl() and gatewayUrl() write it. */
export function subjectPath(subject: AlertSnapshot["subject"]): string {
  const id = subject.id ?? subject.sparkplug_id;
  if (id && subject.type === "device") return `/devices?search=${encodeURIComponent(id)}`;
  if (id && subject.type === "gateway") return `/gateways?search=${encodeURIComponent(id)}`;
  return "/";
}

/** The Settings page's Notifications tab, which a test links to. */
export const NOTIFICATIONS_PATH = "/settings/notifications";

function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

/**
 * The message as a CloudEvents 1.0 event in structured JSON mode. `id` is the queue row's, so a
 * retry carries the same id and a receiver can drop a repeat. `time` is when it happened: the
 * occurrence's start for firing, its end for resolved, and the row's queueing for a reminder or a
 * test.
 */
export function cloudEvent(due: Due, source: string, dashboard: string | null): Record<string, unknown> {
  const link = (path: string) => (dashboard ? `${dashboard}${path}` : null);
  if (due.event === "test" || !due.alert) {
    return {
      specversion: "1.0",
      id: due.id,
      source,
      type: "aber.test",
      time: iso(due.created_at),
      datacontenttype: "application/json",
      data: {
        message: "A test from Aber's Settings page. Nothing is firing.",
        link: link(NOTIFICATIONS_PATH),
      },
    };
  }
  const a = due.alert;
  const time = due.event === "firing" ? a.starts_at : due.event === "resolved" ? (a.ends_at ?? due.created_at) : due.created_at;
  return {
    specversion: "1.0",
    id: due.id,
    source,
    type: `aber.alert.${due.event}`,
    time: iso(time),
    datacontenttype: "application/json",
    data: {
      alert_id: a.id,
      name: a.name,
      severity: a.severity,
      subject: { type: a.subject.type, id: a.subject.id, sparkplug_id: a.subject.sparkplug_id, name: a.subject.name },
      starts_at: iso(a.starts_at),
      ends_at: iso(a.ends_at),
      summary: a.summary,
      labels: a.labels ?? {},
      values: a.values ?? {},
      link: link(subjectPath(a.subject)),
    },
  };
}

/** The key's bytes: Standard Webhooks writes a key as whsec_<base64>. */
export function keyBytes(key: string): Uint8Array {
  const b64 = key.startsWith("whsec_") ? key.slice("whsec_".length) : key;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function base64(bytes: ArrayBuffer): string {
  let text = "";
  for (const b of new Uint8Array(bytes)) text += String.fromCharCode(b);
  return btoa(text);
}

/** `v1,<base64 HMAC-SHA256 of "id.timestamp.body">`, Standard Webhooks' webhook-signature. */
export async function signature(key: string, id: string, timestamp: number, body: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes(key) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return `v1,${base64(mac)}`;
}

/** The headers a signed message goes with. */
export async function signedHeaders(key: string, id: string, timestamp: number, body: string): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/cloudevents+json; charset=utf-8",
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": await signature(key, id, timestamp, body),
  };
}

/** What a post came to. `error` is in the dispatcher's words and never names the address. */
export interface Posted {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/**
 * One post. A redirect is not followed, since its target is not on the allow-list: `manual` hands
 * back the 3xx itself, which is a failure. The body of the answer is read and dropped.
 */
export async function post(
  url: string,
  headers: Record<string, string>,
  body: string,
  fetchImpl: typeof fetch,
  timeoutMs = TIMEOUT_MS,
): Promise<Posted> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "POST", headers, body, redirect: "manual", signal: controller.signal });
    await res.body?.cancel().catch(() => {});
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, error: null };
    // 0 is a browser's opaque redirect; a server runtime hands back the 3xx.
    if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
      const answered = res.status ? `answered ${res.status}, a redirect` : "answered with a redirect";
      return { ok: false, status: res.status || null, error: `The receiver ${answered}, which is not followed.` };
    }
    return { ok: false, status: res.status, error: `The receiver answered ${res.status}.` };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, status: null, error: `The receiver did not answer within ${Math.round(timeoutMs / 1000)} seconds.` };
    }
    // The runtime's own message names the URL, which is a credential: the log has it, redacted.
    const origin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return "the address";
      }
    })();
    const detail = err instanceof Error ? err.message.split(url).join(`${origin}/…`) : String(err);
    console.error(`notification-dispatch: the post to ${origin} failed: ${detail}`);
    return { ok: false, status: null, error: "The receiver could not be reached: the connection, the name lookup or TLS failed." };
  } finally {
    clearTimeout(timer);
  }
}

/** Why the webhook cannot send at all, or null when it can. Never names the address. */
export function destinationProblem(destination: Destination): string | null {
  if (!destination.url) return "The webhook has no address set.";
  if (!destination.signing_key) return "The webhook has no signing key: issue one on the Settings page.";
  if (hostOf(destination.url) === null) return "The webhook's address is not an http or https URL.";
  if (!hostAllowed(destination.url, destination.allowed_hosts ?? [])) {
    return "The webhook's host is not on its allowed hosts, so the message was refused.";
  }
  return null;
}

/**
 * One message: decided, then sent, then recorded. A test is not decided, since it is about no
 * alert. A hold leaves the row pending and pushes it out; it is decided again when it comes due,
 * which is how a message held while its alert is suppressed is sent when the hold lifts.
 */
export async function deliver(due: Due, deps: Deps): Promise<Outcome> {
  if (due.event !== "test") {
    if (!due.alert) {
      await deps.record(due.id, { outcome: "dropped" });
      return "dropped";
    }
    const decision = await deps.decide(due.alert.id, due.event, due.channel);
    if (decision === "drop") {
      await deps.record(due.id, { outcome: "dropped" });
      return "dropped";
    }
    if (decision === "hold") {
      await deps.record(due.id, { outcome: "held", retrySeconds: HOLD_SECONDS });
      return "held";
    }
  }

  const problem = destinationProblem(deps.destination);
  const posted: Posted = problem
    ? { ok: false, status: null, error: problem }
    : await (async () => {
      const body = JSON.stringify(cloudEvent(due, deps.source, deps.dashboard));
      const timestamp = Math.floor(deps.now().getTime() / 1000);
      const headers = await signedHeaders(deps.destination.signing_key!, due.id, timestamp, body);
      return post(deps.destination.url!, headers, body, deps.fetch, deps.timeoutMs);
    })();

  if (posted.ok) {
    await deps.record(due.id, { outcome: "sent", status: posted.status });
    return "sent";
  }
  const next = afterFailure(due.event, due.attempts);
  await deps.record(due.id, { ...next, status: posted.status, error: posted.error });
  return next.outcome;
}
