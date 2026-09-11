import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/**
 * The forge says when `main` moved, and the gateway row remembers. Gitea delivers a push event to
 * this function (the hook is registered at enrolment, forge.ts), and this records the head of
 * `main` on the gateway: sha, message, who, when, and the SHA-256 of `flows.json` at that head.
 * That hash is the forge's half of the drift check: the appliance's heartbeat carries the hash of
 * the flow flow-sync.mjs last deployed, and the gateway drawer compares the two.
 *
 * The signature is the whole of the authentication: `X-Gitea-Signature` is the hex HMAC-SHA256 of
 * the raw body under the hook's secret, verified against GITEA_WEBHOOK_SECRET. The body is read as
 * bytes before it is parsed. A missing or wrong signature is 401; an unset secret is 503, never a
 * pass, since the edge runtime boots with VERIFY_JWT=false.
 *
 * Ignored and answered 200 with a reason: a push to any branch but the tracked one, a repository
 * outside the `gateways` organisation or not named for a gateway, a deleted branch, a non-push
 * event, an unknown gateway. A non-2xx is what Gitea records as a failed delivery, and none of
 * these is a failure.
 */

import { FORGE_ORGANISATION, forgeApi, forgeConfig, GATEWAY_REPOSITORY } from "../_shared/forge.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("GITEA_WEBHOOK_SECRET") ?? "";

const NO_COMMIT = /^0+$/;
const FLOW_FILE = "flows.json";

interface Commit {
  id?: string;
  message?: string;
  timestamp?: string;
  committer?: { name?: string; email?: string };
  author?: { name?: string; email?: string };
}

interface PushPayload {
  ref?: string;
  before?: string;
  after?: string;
  repository?: { name?: string; default_branch?: string; owner?: { login?: string } };
  head_commit?: Commit | null;
  commits?: Commit[];
  pusher?: { login?: string; email?: string; full_name?: string };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, body));
}

/** Constant-time on equal lengths; a length mismatch is already public. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signatureIsValid(presented: string | null, body: Uint8Array, secret: string): Promise<boolean> {
  if (!presented) return false;
  return sameHex(presented.trim().toLowerCase(), await hmacSha256Hex(secret, body));
}

/** The first line of a commit message, trimmed, or null. */
function subjectOf(message: string | undefined): string | null {
  const first = (message ?? "").split(/\r?\n/, 1)[0].trim();
  return first || null;
}

/**
 * SHA-256 of `flows.json` at a commit, read through the machine account. Null when the file is
 * absent at that commit, and null with a warning when the forge could not be asked: a hash that
 * cannot be computed is "not known", never "unchanged".
 */
async function flowHashAt(repository: string, sha: string): Promise<string | null> {
  const cfg = forgeConfig();
  if (!cfg) return null;
  const raw = await forgeApi(cfg, "GET", `/repos/${FORGE_ORGANISATION}/${repository}/raw/${FLOW_FILE}?ref=${sha}`);
  if (raw.status === 404) return null;
  if (!raw.ok) {
    console.warn(`forge-events: could not read ${FLOW_FILE} of '${repository}' at ${sha.slice(0, 12)} (${raw.status})`);
    return null;
  }
  return hex(await crypto.subtle.digest("SHA-256", await raw.arrayBuffer()));
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200 });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!WEBHOOK_SECRET) {
    console.error("forge-events: GITEA_WEBHOOK_SECRET is not configured; refusing every delivery");
    return json({ error: "GITEA_WEBHOOK_SECRET is not configured; refusing to accept deliveries" }, 503);
  }

  const body = new Uint8Array(await req.arrayBuffer());
  if (!(await signatureIsValid(req.headers.get("X-Gitea-Signature"), body, WEBHOOK_SECRET))) {
    console.warn("forge-events: refused a delivery whose signature did not verify");
    return json({ error: "Invalid webhook signature" }, 401);
  }

  const event = req.headers.get("X-Gitea-Event") ?? "";
  if (event !== "push") return json({ ignored: `event '${event}' is not a push` }, 200);

  let payload: PushPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ error: "Body is not valid JSON" }, 400);
  }

  const owner = payload.repository?.owner?.login ?? "";
  const repository = payload.repository?.name ?? "";
  if (owner !== FORGE_ORGANISATION) {
    return json({ ignored: `repository '${owner}/${repository}' is outside the '${FORGE_ORGANISATION}' organisation` }, 200);
  }
  const named = GATEWAY_REPOSITORY.exec(repository);
  if (!named) return json({ ignored: `repository '${repository}' is not a gateway's` }, 200);
  const sparkplugId = named[1];

  const tracked = `refs/heads/${payload.repository?.default_branch || "main"}`;
  if (payload.ref !== tracked) return json({ ignored: `'${payload.ref}' is not the tracked branch` }, 200);

  const sha = payload.after ?? payload.head_commit?.id ?? "";
  if (!sha) return json({ error: "The push names no commit" }, 400);
  if (NO_COMMIT.test(sha)) return json({ ignored: "the tracked branch was deleted" }, 200);

  const head = payload.head_commit ?? payload.commits?.at(-1) ?? null;
  const by = payload.pusher?.email || payload.pusher?.login || head?.committer?.email || head?.committer?.name || null;
  const at = head?.timestamp && !Number.isNaN(Date.parse(head.timestamp))
    ? new Date(head.timestamp).toISOString()
    : new Date().toISOString();

  const flowSha256 = await flowHashAt(repository, sha);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data, error } = await admin
    .from("gateways")
    .update({
      forge_head_sha: sha,
      forge_head_message: subjectOf(head?.message),
      forge_head_by: by,
      forge_head_at: at,
      forge_head_flow_sha256: flowSha256,
    })
    .eq("sparkplug_id", sparkplugId)
    .select("id");

  if (error) {
    console.error(`forge-events: could not record ${sha.slice(0, 12)} on ${sparkplugId}: ${error.message}`);
    return json({ error: "Could not record the push", details: error.message }, 500);
  }
  if (!data || data.length === 0) {
    return json({ ignored: `no gateway has sparkplug id '${sparkplugId}'` }, 200);
  }

  console.log(`forge-events: ${sparkplugId} main is at ${sha.slice(0, 12)}${flowSha256 ? ` (${FLOW_FILE} ${flowSha256.slice(0, 12)})` : ` (no ${FLOW_FILE})`}`);
  return json({ recorded: { sparkplug_id: sparkplugId, sha, flow_sha256: flowSha256 } }, 200);
}

serve(handler);
