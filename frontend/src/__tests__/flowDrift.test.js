import { describe, it, expect } from 'vitest';
import {
  FLOW_DRIFT_GRACE_MS,
  FLOW_DRIFT_UNREPORTED,
  FLOW_DRIFT_NO_HEAD,
  FLOW_DRIFT_NO_FLOW_ON_MAIN,
  FLOW_DRIFT_CONVERGED,
  FLOW_DRIFT_DEPLOYING,
  FLOW_DRIFT_DRIFT,
  flowDriftState,
  flowDriftLabel,
  isFlowDrift,
  flowEditedOnAppliance
} from '../utils/flowDrift';

const NOW = Date.parse('2026-09-11T12:00:00Z');
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

describe('flowDriftState', () => {
  it('is unreported before the appliance has said what it runs', () => {
    expect(flowDriftState({ forge_head_sha: 'c'.repeat(40), forge_head_flow_sha256: A }, NOW)).toBe(FLOW_DRIFT_UNREPORTED);
    expect(flowDriftState(null, NOW)).toBe(FLOW_DRIFT_UNREPORTED);
  });

  it('has nothing to compare against until the forge has reported a push', () => {
    expect(flowDriftState({ flow_hash: A }, NOW)).toBe(FLOW_DRIFT_NO_HEAD);
  });

  it('says so when main carries no flows.json yet', () => {
    expect(flowDriftState({ flow_hash: A, forge_head_sha: 'c'.repeat(40), forge_head_flow_sha256: null }, NOW))
      .toBe(FLOW_DRIFT_NO_FLOW_ON_MAIN);
  });

  it('is converged when the two digests agree', () => {
    const gateway = { flow_hash: A, forge_head_sha: 'c'.repeat(40), forge_head_flow_sha256: A, forge_head_at: iso(0) };
    expect(flowDriftState(gateway, NOW)).toBe(FLOW_DRIFT_CONVERGED);
  });

  it('is deploying, not drift, inside two sync intervals of the push', () => {
    const gateway = { flow_hash: A, forge_head_sha: 'c'.repeat(40), forge_head_flow_sha256: B, forge_head_at: iso(FLOW_DRIFT_GRACE_MS - 1000) };
    expect(flowDriftState(gateway, NOW)).toBe(FLOW_DRIFT_DEPLOYING);
  });

  it('becomes drift once the grace window has passed, with no change to the row', () => {
    const gateway = { flow_hash: A, forge_head_sha: 'c'.repeat(40), forge_head_flow_sha256: B, forge_head_at: iso(FLOW_DRIFT_GRACE_MS + 1000) };
    expect(flowDriftState(gateway, NOW)).toBe(FLOW_DRIFT_DRIFT);
    // The same row, read a minute later, is still drift: the clock decides, not a re-render.
    expect(flowDriftState(gateway, NOW + 60_000)).toBe(FLOW_DRIFT_DRIFT);
  });

  it('calls a difference with no push time drift rather than deploying', () => {
    const gateway = { flow_hash: A, forge_head_sha: 'c'.repeat(40), forge_head_flow_sha256: B, forge_head_at: null };
    expect(flowDriftState(gateway, NOW)).toBe(FLOW_DRIFT_DRIFT);
  });
});

describe('flowDriftLabel and isFlowDrift', () => {
  it('labels the states a person can act on and nothing else', () => {
    expect(flowDriftLabel(FLOW_DRIFT_CONVERGED)).toBe('matches main');
    expect(flowDriftLabel(FLOW_DRIFT_DEPLOYING)).toBe('main moved, deploying');
    expect(flowDriftLabel(FLOW_DRIFT_DRIFT)).toBe('differs from main');
    expect(flowDriftLabel(FLOW_DRIFT_NO_FLOW_ON_MAIN)).toBe('main holds no flow');
    expect(flowDriftLabel(FLOW_DRIFT_UNREPORTED)).toBeNull();
    expect(flowDriftLabel(FLOW_DRIFT_NO_HEAD)).toBeNull();
  });

  it('only drift is a fault', () => {
    expect(isFlowDrift(FLOW_DRIFT_DRIFT)).toBe(true);
    expect(isFlowDrift(FLOW_DRIFT_DEPLOYING)).toBe(false);
    expect(isFlowDrift(FLOW_DRIFT_CONVERGED)).toBe(false);
  });
});

describe('flowEditedOnAppliance', () => {
  it('is unknown until both the heartbeat and the appliance branch have reported', () => {
    expect(flowEditedOnAppliance({ flow_hash: A })).toBeNull();
    expect(flowEditedOnAppliance({ forge_appliance_flow_sha256: A })).toBeNull();
    expect(flowEditedOnAppliance(null)).toBeNull();
  });

  it('reads a running flow that differs from the deployed one as an edit on the box', () => {
    expect(flowEditedOnAppliance({ flow_hash: A, forge_appliance_flow_sha256: A })).toBe(false);
    expect(flowEditedOnAppliance({ flow_hash: A, forge_appliance_flow_sha256: B })).toBe(true);
  });
});
