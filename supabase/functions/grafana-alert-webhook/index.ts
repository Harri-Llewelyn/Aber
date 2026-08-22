import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/**
 * Grafana alert notification receiver.
 *
 * Grafana evaluates the rules in grafana/provisioning/alerting/alert-rules.yaml against the
 * historian and POSTs an Alertmanager-shaped payload here. This function records each alert
 * instance as an OCCURRENCE in public.platform_alerts, which Supabase Realtime then delivers to the
 * dashboard's toast and Topbar pill.
 *
 * ---------------------------------------------------------------------------------------------
 * IT AUTHENTICATES ON A NARROW SHARED SECRET, AND THAT IS THE POINT.
 *
 * The obvious way to let Grafana write to Supabase is to give it the service-role key. That key
 * bypasses RLS entirely and can rewrite `digital_thread`, and this stack has already corrected the
 * same shape once: Grafana used to reach the historian as the `postgres` superuser -- a service
 * fronted by browser SSO holding the credential that owns the database -- and the fix was the
 * read-only `grafana_reader` role.
 *
 * So Grafana holds `GRAFANA_ALERT_WEBHOOK_SECRET`, which authorises exactly one thing: recording an
 * alert. This function verifies it and then uses its own service-role client internally. Same shape
 * as `nodered_webhook_jwt_secret` for the quarantine webhook.
 *
 * THE CHECK IS NOT OPTIONAL AND CANNOT BE DELEGATED. The edge runtime boots with
 * VERIFY_JWT="false" because each function authorises itself, so a function that forgets to check
 * is an open write endpoint rather than a 401. Kong's key-auth in front of /functions/v1/ proves
 * only that the caller has the anon key -- which is shipped to every browser.
 *
 * ---------------------------------------------------------------------------------------------
 * IDENTITY COMES FROM `sparkplug_id`, NEVER FROM THE DEVICE NAME.
 *
 * `devices.name` is a mutable display label; `sparkplug_id` is generated from the row's primary key
 * and is what the ACL, the MQTT topic and the historian all key on. `identity_source =
 * 'legacy_name'` exists specifically to deprecate name matching and the UI badges it as a warning.
 * The alert rules therefore carry `sparkplug_id` as a label and this function resolves on it; the
 * device NAME travels too, but only so a summary can be read by a human.
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
 * Constant-time-ish comparison of the bearer token.
 *
 * A plain `!==` on a secret leaks its length and, in principle, its prefix through timing. This is
 * a shared secret on an internal network rather than a password database, so the exposure is small
 * -- but the mitigation is three lines and the alternative is explaining why it was skipped.
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
  // FAIL CLOSED ON AN UNSET SECRET. An empty expected value would otherwise make `Bearer ` match,
  // turning a misconfiguration into an unauthenticated write endpoint -- the exact inversion that
  // makes a missing environment variable dangerous rather than merely broken.
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
 * Normalise one Grafana alert instance into a platform_alerts row.
 *
 * THE SUBJECT IS (entity_type, entity_id), NOT A DEVICE. Until the platform rules arrived every
 * alert was a machine condition, so an instance without a `sparkplug_id` label could only be
 * malformed and was dropped. That is no longer true: a rule about the quarantine queue depth or
 * the number of stuck enrolments is about the fleet, and has no asset to name.
 *
 * A rule therefore declares its own scope with an `entity_type` label -- `device` (the default,
 * so the three shipped machine rules are unchanged), `gateway`, or `platform`.
 *
 * RETURNS NULL ONLY FOR A MALFORMED INSTANCE, and that is still not an error condition: a
 * DatasourceError notification (which `execErrState: Error` produces when a rule's query breaks)
 * carries no labels at all, and neither does anything an operator adds through the Grafana UI. The
 * caller counts these and reports the count, so a rule that has started erroring is visible in
 * Grafana's own delivery log rather than being written in as an alert about nothing.
 *
 * AN ASSET SCOPE STILL REQUIRES A WIRE IDENTITY. `platform_alerts_asset_has_wire_id` enforces that
 * in the schema; refusing it here as well means the batch is not failed by one bad instance.
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

  // DEFAULTS TO `device`, which is what keeps the three machine rules working untouched -- none of
  // them carries this label. An unrecognised value is refused rather than coerced: the CHECK in
  // 0023 would reject it anyway, and failing one instance here beats failing the whole batch's
  // insert there.
  const entityType = (labels.entity_type ?? "device").trim().toLowerCase();
  if (!ENTITY_TYPES.has(entityType)) return null;

  // Only a platform-scoped alert may omit the wire identity. Anything else claiming to be about an
  // asset without naming it is the failure this function has always existed to prevent.
  if (entityType !== "platform" && !sparkplugId) return null;

  // Grafana sends `status: "resolved"` on recovery and "firing" otherwise. Anything unrecognised is
  // treated as firing: a notification that arrived is evidence of a condition, and defaulting to
  // resolved would silently clear the dashboard on a payload shape we do not know.
  const resolved = (alert.status ?? "").toLowerCase() === RESOLVED;

  // An unset or zero endsAt is Alertmanager's "still open". Grafana sends 0001-01-01T00:00:00Z for
  // a firing alert, which is not a timestamp anybody wants stored -- and the table's CHECK requires
  // a resolved row to carry one, so this is where that gets settled.
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

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // ONE ROUND TRIP PER SUBJECT TABLE, not one per alert. A multi-dimensional rule can deliver six
  // instances in a single notification, and `sparkplug_id` is indexed on both tables -- so an `in`
  // filter is two queries where a loop would be twelve.
  //
  // THE TWO ARE LOOKED UP SEPARATELY BECAUSE A WIRE ID IS ONLY UNIQUE WITHIN ITS KIND. Device ids
  // are `dev`-prefixed and gateway ids `gwy`-prefixed today, so one combined map would happen to
  // work -- but it would be relying on a naming convention to keep two id spaces apart, and
  // `entity_type` already says which space to look in. Resolving by the declared kind means a
  // future prefix change cannot silently attribute a gateway alert to a device.
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
      // Recorded anyway, with a null entity_id. The alert is the event worth keeping; the id is a
      // convenience for joining. Losing a real excursion because a metadata lookup failed would be
      // the wrong trade.
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

  // UPSERT ON (fingerprint, starts_at) -- the OCCURRENCE key, not the fingerprint alone.
  //
  // A Grafana fingerprint is a hash of the alert instance's labels and is therefore STABLE across
  // every fire -> resolve -> fire cycle for the same series. Conflict-targeting it alone would make
  // the second excursion overwrite the first, and the table would quietly become "latest occurrence
  // per series" while still carrying starts_at/ends_at. Pairing it with starts_at gives one row per
  // occurrence -- and because the resolve notification repeats the SAME startsAt, the resolve closes
  // the row it opened instead of inserting a second one.
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

serve(handler);
