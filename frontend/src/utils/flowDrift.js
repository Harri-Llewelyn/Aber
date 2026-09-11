/**
 * Whether a gateway runs the flow at the head of its repository. Two SHA-256 digests of
 * flows.json meet on the gateway row: `flow_hash`, which the appliance reports on its heartbeat
 * from the record flow-sync.mjs writes after every deploy, and `forge_head_flow_sha256`, which
 * forge-events records from the head of main on every push. Equal is convergence. Different is
 * either the puller not having ticked since the push or drift, and the age of the push is what
 * separates the two.
 */

/** flow-sync.mjs ticks every FLOW_SYNC_INTERVAL_SECONDS, 300 by default. */
export const FLOW_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How long after a push a difference is called "deploying" rather than drift: two ticks, so one
 * failed tick (the forge unreachable, Node-RED restarting) is not reported as a fault.
 */
export const FLOW_DRIFT_GRACE_MS = 2 * FLOW_SYNC_INTERVAL_MS;

export const FLOW_DRIFT_UNREPORTED = 'unreported';
export const FLOW_DRIFT_NO_HEAD = 'no-head';
export const FLOW_DRIFT_NO_FLOW_ON_MAIN = 'no-flow-on-main';
export const FLOW_DRIFT_CONVERGED = 'converged';
export const FLOW_DRIFT_DEPLOYING = 'deploying';
export const FLOW_DRIFT_DRIFT = 'drift';

/**
 * One of the six states above. `now` is a parameter so the grace window is testable and so the
 * page's clock tick, not a render, decides when "deploying" becomes "drift".
 */
export function flowDriftState(gateway, now = Date.now()) {
  if (!gateway?.flow_hash) return FLOW_DRIFT_UNREPORTED;
  if (!gateway.forge_head_sha) return FLOW_DRIFT_NO_HEAD;
  if (!gateway.forge_head_flow_sha256) return FLOW_DRIFT_NO_FLOW_ON_MAIN;
  if (gateway.flow_hash === gateway.forge_head_flow_sha256) return FLOW_DRIFT_CONVERGED;

  const pushedAt = gateway.forge_head_at ? new Date(gateway.forge_head_at).getTime() : NaN;
  if (Number.isFinite(pushedAt) && now - pushedAt < FLOW_DRIFT_GRACE_MS) return FLOW_DRIFT_DEPLOYING;
  return FLOW_DRIFT_DRIFT;
}

/** The short phrase shown beside the hash in the drawer, or null when there is nothing to compare. */
export function flowDriftLabel(state) {
  switch (state) {
    case FLOW_DRIFT_CONVERGED: return 'matches main';
    case FLOW_DRIFT_DEPLOYING: return 'main moved, deploying';
    case FLOW_DRIFT_DRIFT: return 'differs from main';
    case FLOW_DRIFT_NO_FLOW_ON_MAIN: return 'main holds no flow';
    default: return null;
  }
}

/** The one state that is a fault a person should look at. */
export function isFlowDrift(state) {
  return state === FLOW_DRIFT_DRIFT;
}
