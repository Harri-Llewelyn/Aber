import { serviceRoleClient } from "../_shared/serviceClient.ts";

/**
 * Grafana alert notification receiver. Grafana evaluates the rules in
 * grafana/provisioning/alerting/alert-rules.yaml against the historian and POSTs an
 * Alertmanager-shaped payload here; this records each alert instance as an occurrence in
 * public.platform_alerts, which Realtime delivers to the dashboard. It authenticates on a narrow
 * shared secret, GRAFANA_ALERT_WEBHOOK_SECRET, which authorises exactly one thing, and only then
 * uses its own service-role client; giving Grafana the service-role key would hand a
 * browser-SSO-fronted service the credential that bypasses RLS. The check cannot be delegated: the
 * edge runtime boots with VERIFY_JWT="false", and the gateway's key-auth proves only that the
 * caller has the anon key. Identity comes from `sparkplug_id`, never from the device name, which is
 * a mutable label; the name travels only so a summary can be read.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("GRAFANA_ALERT_WEBHOOK_SECRET") ?? "";

/** Grafana's own label for an instance that has recovered. */
const RESOLVED = "resolved";
const FIRING = "firing";

const SEVERITIES = new Set(["critical", "warning", "info"]);
/** Mirrors `platform_alerts_entity_type_valid` in 0023. Kept in step by test_grafana_alert_webhook.py. */
const ENTITY_TYPES = new Set(["device", "gateway", "platform"]);

interface GrafanaAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  fingerprint?: string;
  startsAt?: string;
  endsAt?: string;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Constant-time-ish comparison of the bearer token: a plain `!==` leaks its length and prefix
 * through timing.
 */
function secretMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function authorizeAlertWebhook(
  authHeader: string | null,
  expectedSecret: string,
): { ok: boolean; status: number; message: string } {
  // Fail closed on an unset secret: an empty expected value would otherwise make `Bearer ` match,
  // turning a misconfiguration into an unauthenticated write endpoint.
  if (!expectedSecret) {
    return {
      ok: false,
      status: 503,
      message: "GRAFANA_ALERT_WEBHOOK_SECRET is not configured; refusing to accept alerts",
    };
  }
  if (!authHeader) {
    return { ok: false, status: 401, message: "Missing Authorization header" };
  }
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) {
    return { ok: false, status: 401, message: "Authorization header must be a Bearer token" };
  }
  if (!secretMatches(match[1], expectedSecret)) {
    return { ok: false, status: 401, message: "Invalid webhook secret" };
  }
  return { ok: true, status: 200, message: "Authorized" };
}

/**
 * Normalise one Grafana alert instance into a platform_alerts row. The subject is (entity_type,
 * entity_id), not a device: a rule declares its scope with an `entity_type` label, `device` (the
 * default), `gateway` or `platform`. Returns null only for a malformed instance, which is not an
 * error: a DatasourceError notification carries no labels, and the caller counts and reports these.
 * An asset scope still requires a wire identity, as `platform_alerts_asset_has_wire_id` enforces;
 * refusing it here keeps one bad instance from failing the batch.
 */
export function normalizeAlert(alert: GrafanaAlert): {
  fingerprint: string;
  entity_type: string;
  sparkplug_id: string | null;
  alert_name: string;
  severity: string;
  status: string;
  summary: string | null;
  starts_at: string;
  ends_at: string | null;
  device_name: string | null;
} | null {
  const labels = alert.labels ?? {};
  const annotations = alert.annotations ?? {};

  const sparkplugId = labels.sparkplug_id?.trim() || null;
  const fingerprint = alert.fingerprint?.trim();
  const alertName = (labels.alertname ?? "").trim();
  if (!fingerprint || !alertName || !alert.startsAt) return null;

  // Defaults to `device`, which keeps the machine rules working without the label. An unrecognised
  // value is refused rather than coerced, so one instance fails rather than the whole batch's
  // insert.
  const entityType = (labels.entity_type ?? "device").trim().toLowerCase();
  if (!ENTITY_TYPES.has(entityType)) return null;

  // Only a platform-scoped alert may omit the wire identity. Anything else claiming to be about an
  // asset without naming it is the failure this function has always existed to prevent.
  if (entityType !== "platform" && !sparkplugId) return null;

  // Grafana sends `status: "resolved"` on recovery and "firing" otherwise. Anything unrecognised is
  // treated as firing: defaulting to resolved would silently clear the dashboard on an unknown
  // payload shape.
  const resolved = (alert.status ?? "").toLowerCase() === RESOLVED;

  // An unset or zero endsAt is Alertmanager's "still open"; Grafana sends 0001-01-01T00:00:00Z for
  // a firing alert. The table's CHECK requires a resolved row to carry one.
  const rawEnds = alert.endsAt ?? "";
  const endsAt = resolved
    ? (rawEnds && !rawEnds.startsWith("0001-01-01") ? rawEnds : new Date().toISOString())
    : null;

  const severity = (labels.severity ?? "warning").toLowerCase();

  return {
    fingerprint,
    entity_type: entityType,
    sparkplug_id: sparkplugId,
    alert_name: alertName,
    // Constrained by a CHECK in 0023, so an unexpected label value is mapped rather than allowed to
    // fail the whole batch's insert.
    severity: SEVERITIES.has(severity) ? severity : "warning",
    status: resolved ? RESOLVED : FIRING,
    summary: annotations.summary?.trim() || annotations.description?.trim() || null,
    starts_at: alert.startsAt,
    ends_at: endsAt,
    device_name: labels.device?.trim() || null,
  };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200 });
  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  const auth = authorizeAlertWebhook(req.headers.get("Authorization"), WEBHOOK_SECRET);
  if (!auth.ok) {
    console.warn(`[grafana-alert-webhook] refused: ${auth.message}`);
    return jsonResponse({ success: false, error: auth.message }, auth.status);
  }

  let payload: { alerts?: GrafanaAlert[] };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ success: false, error: "Body is not valid JSON" }, 400);
  }

  const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
  if (alerts.length === 0) {
    // Not an error. Grafana sends a test notification with an empty array when someone presses
    // "Test" on the contact point, and answering 400 makes that look like a broken integration.
    return jsonResponse({ success: true, received: 0, written: 0, skipped: 0 }, 200);
  }

  const rows = [];
  let skipped = 0;
  for (const alert of alerts) {
    const row = normalizeAlert(alert);
    if (!row) {
      skipped += 1;
      continue;
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    console.warn(`[grafana-alert-webhook] ${skipped} alert(s) were not attributable`);
    return jsonResponse({ success: true, received: alerts.length, written: 0, skipped }, 200);
  }

  const supabaseAdmin = serviceRoleClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // One round trip per subject table, not one per alert: a multi-dimensional rule can deliver six
  // instances in one notification. The two kinds are looked up separately because a wire id is only
  // unique within its kind, and `entity_type` says which space to look in.
  const idsFor = (kind: string) =>
    [...new Set(rows.filter((r) => r.entity_type === kind && r.sparkplug_id).map((r) => r.sparkplug_id!))];

  const subjectId = new Map<string, string>();
  const key = (kind: string, wireId: string) => `${kind}:${wireId}`;

  for (const [kind, table] of [["device", "devices"], ["gateway", "gateways"]] as const) {
    const ids = idsFor(kind);
    if (ids.length === 0) continue;

    const { data, error } = await supabaseAdmin
      .from(table)
      .select("id, sparkplug_id")
      .in("sparkplug_id", ids);

    if (error) {
      // Recorded anyway, with a null entity_id: the alert is the event worth keeping, and the id is
      // a convenience for joining.
      console.error(`[grafana-alert-webhook] ${table} lookup failed: ${error.message}`);
      continue;
    }
    for (const row of data ?? []) subjectId.set(key(kind, row.sparkplug_id), row.id);
  }

  const toWrite = rows.map((r) => ({
    fingerprint: r.fingerprint,
    entity_type: r.entity_type,
    entity_id: r.sparkplug_id ? subjectId.get(key(r.entity_type, r.sparkplug_id)) ?? null : null,
    sparkplug_id: r.sparkplug_id,
    alert_name: r.alert_name,
    severity: r.severity,
    status: r.status,
    summary: r.summary,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
  }));

  // Upsert on (fingerprint, starts_at), the occurrence key. A Grafana fingerprint is a hash of the
  // instance's labels and is stable across every fire/resolve cycle, so conflicting on it alone
  // would overwrite the first excursion with the second. The resolve notification repeats the same
  // startsAt, so it closes the row it opened.
  const { error: writeError } = await supabaseAdmin
    .from("platform_alerts")
    .upsert(toWrite, { onConflict: "fingerprint,starts_at" });

  if (writeError) {
    console.error(`[grafana-alert-webhook] write failed: ${writeError.message}`);
    return jsonResponse({ success: false, error: writeError.message }, 500);
  }

  const firing = toWrite.filter((r) => r.status === FIRING).length;
  console.log(
    `[grafana-alert-webhook] recorded ${toWrite.length} alert(s) ` +
      `(${firing} firing, ${toWrite.length - firing} resolved, ${skipped} skipped)`,
  );

  return jsonResponse(
    { success: true, received: alerts.length, written: toWrite.length, skipped },
    200,
  );
}

Deno.serve(handler);
