import { serviceRoleClient } from "../_shared/serviceClient.ts";

/**
 * The forge says when `main` or `appliance` moved, and the gateway row remembers. Gitea delivers a
 * push event to this function (the hook is registered at enrolment, forge.ts), and this records
 * the head of `main` on the gateway: sha, message, who, when, and the SHA-256 of `flows.json` at
 * that head. That hash is the forge's half of the drift check: the appliance's heartbeat carries
 * the hash of the flow flow-sync.mjs last deployed, and the gateway drawer compares the two. A
 * push to `appliance`, which only the appliance's deploy key can make, records the head of that
 * branch beside it (0104): when the appliance last reported, the digest of the flows.json it says
 * it is running, and what `converged.json` on that branch says its last convergence did -- the
 * platform tag and outcome, and what this gateway's own custom.yml did (0106).
 *
 * The signature is the whole of the authentication: `X-Gitea-Signature` is the hex HMAC-SHA256 of
 * the raw body under the hook's secret, verified against GITEA_WEBHOOK_SECRET. The body is read as
 * bytes before it is parsed. A missing or wrong signature is 401; an unset secret is 503, never a
 * pass, since the edge runtime boots with VERIFY_JWT=false.
 *
 * A push to any OTHER branch is a proposal. Nothing on the gateway row moves, but the flows.json
 * at that commit is checked for shape and the `aber/flow-shape` status main requires is posted, so
 * a file uploaded through the forge's own UI meets a check before an administrator merges it
 * rather than being refused on the appliance afterwards.
 *
 * Ignored and answered 200 with a reason: a repository outside the `gateways` organisation or not
 * named for a gateway, a deleted branch, a non-push event, an unknown gateway. A non-2xx is what
 * Gitea records as a failed delivery, and none of these is a failure.
 */

import {
  APPLIANCE_BRANCH,
  FLOW_SHAPE_CONTEXT,
  FORGE_ORGANISATION,
  forgeApi,
  forgeConfig,
  GATEWAY_REPOSITORY,
  postCommitStatus,
} from "../_shared/forge.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("GITEA_WEBHOOK_SECRET") ?? "";

const NO_COMMIT = /^0+$/;
const FLOW_FILE = "flows.json";
/** What aber-gateway-converge records, carried on the same branch by the same allowlist. */
const CONVERGED_FILE = "converged.json";

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

async function hmacSha256Hex(secret: string, body: BufferSource): Promise<string> {
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

export async function signatureIsValid(presented: string | null, body: BufferSource, secret: string): Promise<boolean> {
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

/**
 * Why a committed flow would be refused, or null when it would not.
 *
 * THE SAME TWO CHECKS `flow-sync.mjs` MAKES, and they must stay the same two: this one runs in the
 * forge before a merge, the puller's runs on the appliance after one, and a file that passes here
 * and fails there is worse than no check at all, because a person was told it was fine. Kept in
 * step by hand; `flowRejectionReason()` in
 * forge/gateway-platform/appliance/flow-sync.mjs is the other copy.
 */
function flowRejectionReason(flow: unknown): string | null {
  if (!Array.isArray(flow)) {
    return "a Node-RED flow export is a JSON array of nodes, and this file is not one";
  }
  // Every entry an object with no `type` is the shape of flows_cred.json, which is a map of node
  // id to encrypted credential. Deployed as a flow it gives the broker node an empty username and
  // the gateway is refused with CONNACK 5.
  if (flow.length && flow.every((n) => typeof n === "object" && n !== null && !(n as { type?: unknown }).type)) {
    return "this looks like flows_cred.json rather than flows.json, and a credential file must never be deployed as a flow";
  }
  return null;
}

/**
 * Check the `flows.json` at a pushed commit and post the status `main` requires.
 *
 * A repository with no `flows.json` yet passes: that is the ordinary state of one enrolment just
 * created, and a proposal that adds something else to it is not a flow change. A file the forge
 * cannot be asked about is an `error` status rather than a pass, because "not known" must not
 * merge.
 */
async function checkFlowShape(repository: string, sha: string): Promise<Record<string, unknown>> {
  const cfg = forgeConfig();
  if (!cfg) return { posted: false, reason: "this deployment has no forge configured" };

  const raw = await forgeApi(cfg, "GET", `/repos/${FORGE_ORGANISATION}/${repository}/raw/${FLOW_FILE}?ref=${sha}`);
  if (raw.status === 404) {
    await postCommitStatus(cfg, repository, sha, "success", `no ${FLOW_FILE} in this commit`);
    return { state: "success", detail: `no ${FLOW_FILE}` };
  }
  if (!raw.ok) {
    const detail = `could not read ${FLOW_FILE} (${raw.status})`;
    await postCommitStatus(cfg, repository, sha, "error", detail);
    return { state: "error", detail };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await raw.text());
  } catch (err) {
    const detail = `${FLOW_FILE} is not valid JSON (${err instanceof Error ? err.message : err})`;
    await postCommitStatus(cfg, repository, sha, "failure", detail);
    return { state: "failure", detail };
  }

  const rejection = flowRejectionReason(parsed);
  if (rejection) {
    await postCommitStatus(cfg, repository, sha, "failure", rejection);
    return { state: "failure", detail: rejection };
  }
  await postCommitStatus(cfg, repository, sha, "success", `${FLOW_FILE} is a Node-RED flow array`);
  return { state: "success", detail: `${FLOW_FILE} is a flow array` };
}

/** The five columns `converged.json` fills, all null when there is nothing to read. */
interface ConvergenceRecord {
  forge_appliance_platform_tag: string | null;
  forge_appliance_platform_outcome: string | null;
  forge_appliance_converged_at: string | null;
  forge_appliance_custom_outcome: string | null;
  forge_appliance_custom_revision: string | null;
}

const NO_CONVERGENCE: ConvergenceRecord = {
  forge_appliance_platform_tag: null,
  forge_appliance_platform_outcome: null,
  forge_appliance_converged_at: null,
  forge_appliance_custom_outcome: null,
  forge_appliance_custom_revision: null,
};

/** A string field of an object, trimmed and length-capped, or null for anything else. */
function field(source: Record<string, unknown> | null, name: string, max = 200): string | null {
  const value = source?.[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * What the appliance converged to, from `converged.json` at the head of the `appliance` branch.
 * The file is written by `aber-gateway-converge` on the appliance and pushed here by the puller.
 *
 * EVERY FIELD IS TREATED AS UNTRUSTED. It is JSON from a box in a cabinet, arriving over a deploy
 * key: absent, malformed and unexpected shapes all resolve to nulls rather than to a failed
 * delivery, because a non-2xx is a failed webhook on the hook's page and the flow half of this
 * push is what actually matters. A timestamp that is not one is dropped rather than passed to
 * Postgres, which would refuse the whole update.
 */
async function convergenceAt(repository: string, sha: string): Promise<ConvergenceRecord> {
  const cfg = forgeConfig();
  if (!cfg) return NO_CONVERGENCE;
  const raw = await forgeApi(cfg, "GET", `/repos/${FORGE_ORGANISATION}/${repository}/raw/${CONVERGED_FILE}?ref=${sha}`);
  // The ordinary state of an appliance that runs the bundle without the platform playbook.
  if (raw.status === 404) return NO_CONVERGENCE;
  if (!raw.ok) {
    console.warn(`forge-events: could not read ${CONVERGED_FILE} of '${repository}' at ${sha.slice(0, 12)} (${raw.status})`);
    return NO_CONVERGENCE;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await raw.text()) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
  } catch (err) {
    console.warn(`forge-events: ${CONVERGED_FILE} of '${repository}' is not readable JSON (${err instanceof Error ? err.message : err})`);
    return NO_CONVERGENCE;
  }

  const custom = typeof parsed.custom === "object" && parsed.custom !== null
    ? parsed.custom as Record<string, unknown>
    : null;
  const at = field(parsed, "converged_at");

  return {
    forge_appliance_platform_tag: field(parsed, "tag", 64),
    forge_appliance_platform_outcome: field(parsed, "outcome", 32),
    forge_appliance_converged_at: at && Number.isFinite(Date.parse(at)) ? at : null,
    forge_appliance_custom_outcome: field(custom, "outcome", 32),
    forge_appliance_custom_revision: field(custom, "revision", 64),
  };
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
  const reported = `refs/heads/${APPLIANCE_BRANCH}`;
  const branch = payload.ref === tracked ? "main" : payload.ref === reported ? APPLIANCE_BRANCH : null;

  const sha = payload.after ?? payload.head_commit?.id ?? "";
  if (!sha) return json({ error: "The push names no commit" }, 400);
  if (NO_COMMIT.test(sha)) {
    return json({ ignored: `the '${payload.ref}' branch was deleted` }, 200);
  }

  // A PROPOSAL BRANCH. Nothing on the gateway row moves -- only main and appliance are recorded --
  // but the shape of the flows.json being proposed is checked here, and the status main requires
  // is posted. A file uploaded through the forge's own UI met no check until the appliance refused
  // it, which is after an administrator had approved and merged it.
  if (!branch) {
    const checked = await checkFlowShape(repository, sha);
    console.log(`forge-events: ${sparkplugId} ${payload.ref} ${FLOW_SHAPE_CONTEXT}=${checked.state} (${checked.detail})`);
    return json({ checked: { sparkplug_id: sparkplugId, ref: payload.ref, context: FLOW_SHAPE_CONTEXT, ...checked } }, 200);
  }

  const head = payload.head_commit ?? payload.commits?.at(-1) ?? null;
  const by = payload.pusher?.email || payload.pusher?.login || head?.committer?.email || head?.committer?.name || null;
  const at = head?.timestamp && !Number.isNaN(Date.parse(head.timestamp))
    ? new Date(head.timestamp).toISOString()
    : new Date().toISOString();

  const flowSha256 = await flowHashAt(repository, sha);
  // The merged head carries the status too. Nothing requires it there -- protection applies to a
  // merge INTO main -- but it is what the forge shows beside the commit, and a check whose result
  // disappears at the moment it is merged reads as one that did not run.
  if (branch === "main") await checkFlowShape(repository, sha);

  // Nobody is named for the appliance branch: a deploy-key push carries whatever author the
  // appliance set, and the branch's protection already says who can have written it.
  const record = branch === APPLIANCE_BRANCH
    ? {
      forge_appliance_sha: sha,
      forge_appliance_at: at,
      forge_appliance_flow_sha256: flowSha256,
      ...(await convergenceAt(repository, sha)),
    }
    : {
      forge_head_sha: sha,
      forge_head_message: subjectOf(head?.message),
      forge_head_by: by,
      forge_head_at: at,
      forge_head_flow_sha256: flowSha256,
    };

  const admin = serviceRoleClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await admin
    .from("gateways")
    .update(record)
    .eq("sparkplug_id", sparkplugId)
    .select("id");

  if (error) {
    console.error(`forge-events: could not record ${sha.slice(0, 12)} on ${sparkplugId}: ${error.message}`);
    return json({ error: "Could not record the push", details: error.message }, 500);
  }
  if (!data || data.length === 0) {
    return json({ ignored: `no gateway has sparkplug id '${sparkplugId}'` }, 200);
  }

  console.log(`forge-events: ${sparkplugId} ${branch} is at ${sha.slice(0, 12)}${flowSha256 ? ` (${FLOW_FILE} ${flowSha256.slice(0, 12)})` : ` (no ${FLOW_FILE})`}`);
  return json({ recorded: { sparkplug_id: sparkplugId, branch, sha, flow_sha256: flowSha256 } }, 200);
}

Deno.serve(handler);
