import { serviceRoleClient } from "../_shared/serviceClient.ts";
import { serverError } from "../_shared/failure.ts";
import { type Decision, deliver, type Destination, type Due, type Outcome } from "./dispatch.ts";

/**
 * Aber's dispatcher: drains public.notification_deliveries, the queue 0247's trigger fills as an
 * alert starts firing or resolves and as a reminder comes due, and posts each message to the
 * webhook 0248 configures. The database asks for a pass through pg_net as it queues a row, and
 * pg_cron's sweep asks every minute while a row is due (sweep_forge()'s shape).
 *
 * Authorised by the dispatch secret in `x-dispatch-secret`, which the database generated and alone
 * sends: the gateway's key check proves only that the caller holds a key every browser has, and
 * the edge runtime boots with VERIFY_JWT=false. Nothing a caller sends chooses what is sent: every
 * message comes from the queue, so a caller holding the secret can only make the queue drain sooner.
 *
 * Runs as the service role, past RLS, so the database applies each row's visibility itself: no
 * message about a machine identity's alert is selected for the webhook (0247).
 *
 * One pass at a time, under notification_dispatch_lease: a call that finds it held answers 200
 * `already_dispatching`, and the holder's release asks for one more pass.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
/** The dashboard's address: the CloudEvents source, and the root of each message's link. */
const DASHBOARD = (Deno.env.get("FRONTEND_PUBLIC_URL") ?? "").replace(/\/+$/, "");

/** The lease is renewed before every row, so it need outlast only one post. */
const LEASE_SECONDS = 60;
/** A pass stops taking rows here and asks for another, inside the runtime's 60-second limit. */
const PASS_BUDGET_MS = 40_000;
const BATCH = 20;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Admin = ReturnType<typeof serviceRoleClient>;

async function rpc<T>(admin: Admin, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}

/** Never throws: the pass has answered for itself, and a lease left held lapses. */
async function release(admin: Admin, holder: string, again: boolean): Promise<void> {
  try {
    const released = await rpc<boolean>(admin, "release_notification_dispatch", { p_holder: holder, p_again: again });
    if (!released) console.warn("notification-dispatch: this pass outlived its lease, which another pass then took");
  } catch (err) {
    console.error(
      `notification-dispatch: could not release the lease (${err instanceof Error ? err.message : err}); ` +
        `it lapses within ${LEASE_SECONDS}s`,
    );
  }
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured" }, 503);
  }
  const admin = serviceRoleClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let trusted: boolean;
  try {
    trusted = await rpc<boolean>(admin, "notification_dispatch_secret_matches", {
      p_secret: req.headers.get("x-dispatch-secret") ?? "",
    });
  } catch (err) {
    return serverError(req, "notification-dispatch", err, { status: 502, error: "Could not check the caller" });
  }
  // No detail about why: distinguishing "no header" from "wrong value" is a hint.
  if (!trusted) return json({ error: "unauthorized" }, 401);

  let holder: string | null;
  try {
    holder = await rpc<string | null>(admin, "claim_notification_dispatch", { p_seconds: LEASE_SECONDS });
  } catch (err) {
    return serverError(req, "notification-dispatch", err, { status: 502, error: "Could not read the dispatch lease" });
  }
  // 200, not an error status: pg_net records the status, and nothing failed. The pass holding the
  // lease, or the one its release asks for, sends whatever this call was asked about.
  if (!holder) return json({ already_dispatching: true }, 200);

  const counts: Record<Outcome, number> = { sent: 0, dropped: 0, held: 0, failed: 0, dead: 0 };
  const started = Date.now();
  let again = false;
  try {
    const destination = await rpc<Destination>(admin, "notification_webhook_destination");
    const lease = holder;
    const deps = {
      decide: (alertId: string, event: string, channel: string) =>
        rpc<Decision>(admin, "platform_alert_send_decision", { p_alert_id: alertId, p_event: event, p_channel: channel }),
      record: async (id: string, r: { outcome: Outcome; retrySeconds?: number; status?: number | null; error?: string | null }) => {
        await rpc<string | null>(admin, "record_notification_delivery", {
          p_holder: lease, p_id: id, p_outcome: r.outcome, p_retry_seconds: r.retrySeconds ?? null,
          p_status: r.status ?? null, p_error: r.error ?? null,
        });
      },
      destination: { ...destination, allowed_hosts: Array.isArray(destination?.allowed_hosts) ? destination.allowed_hosts : [] },
      fetch,
      now: () => new Date(),
      source: DASHBOARD || "urn:aber",
      dashboard: DASHBOARD || null,
    };

    pass: while (true) {
      const due = await rpc<Due[]>(admin, "notification_deliveries_due", { p_holder: lease, p_limit: BATCH });
      if (!due?.length) break;
      for (const row of due) {
        if (Date.now() - started > PASS_BUDGET_MS) {
          again = true;
          break pass;
        }
        // Renewed before each post, so a pass that lost its lease sends nothing more.
        if (!await rpc<boolean>(admin, "renew_notification_dispatch", { p_holder: lease, p_seconds: LEASE_SECONDS })) {
          console.warn("notification-dispatch: the lease lapsed during the pass; stopping");
          break pass;
        }
        counts[await deliver(row, deps)] += 1;
      }
      if (due.length < BATCH) break;
    }
  } catch (err) {
    return serverError(req, "notification-dispatch", err, {
      status: 502,
      error: "The pass could not complete",
      context: `after ${JSON.stringify(counts)}`,
    });
  } finally {
    await release(admin, holder, again);
  }

  if (counts.sent || counts.failed || counts.dead) console.log(`notification-dispatch: ${JSON.stringify(counts)}`);
  return json(counts, 200);
}

Deno.serve(handler);
