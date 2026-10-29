import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * An area's plan turned through the API layer. A turn is one write of plan_rotation and nothing
 * else; Remove plan resets the turn in the same write as the plan, since the database refuses a
 * turn on an area with no plan; Replace plan writes no turn, so the area keeps it.
 */

const calls = vi.hoisted(() => ({ update: [], result: null }));

vi.mock('../lib/supabaseClient', () => {
  const builder = {
    update: vi.fn((patch) => { calls.update.push(patch); return builder; }),
    eq: vi.fn(() => builder),
    select: vi.fn(() => Promise.resolve(calls.result ?? { data: [{ id: 'a' }], error: null }))
  };
  const bucket = { upload: vi.fn(async () => ({ error: null })), remove: vi.fn(async () => ({ error: null })) };
  return {
    SUPABASE_URL: 'http://stack.test',
    SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
    supabase: { from: vi.fn(() => builder), storage: { from: vi.fn(() => bucket) }, auth: { getSession: vi.fn() } }
  };
});

import { api } from '../api';

const area = (plan_rotation) => ({ area_id: 'a', plan_path: 'a/plan-1.svg', plan_aspect: 2, plan_rotation });

beforeEach(() => {
  calls.update.length = 0;
  calls.result = null;
});

describe('turning an area plan', () => {
  it('writes the next quarter turn, and nothing else', async () => {
    await api.turnAreaPlan(area(0), 1);
    await api.turnAreaPlan(area(270), 1);
    await api.turnAreaPlan(area(0), -1);
    await api.turnAreaPlan(area(90), -1);
    expect(calls.update).toEqual([{ plan_rotation: 90 }, { plan_rotation: 0 }, { plan_rotation: 270 }, { plan_rotation: 0 }]);
  });

  it('tells a turn RLS refused from one that was made', async () => {
    calls.result = { data: [], error: null };
    await expect(api.turnAreaPlan(area(0), 1)).rejects.toThrow(/permission to change this area/);
  });

  it('says so when the plan was removed since the page read it', async () => {
    calls.result = { data: null, error: { code: '23514', message: 'new row for relation "areas" violates check constraint "areas_plan_rotation_needs_a_plan"' } };
    await expect(api.turnAreaPlan(area(90), 1)).rejects.toThrow('The area has no plan to turn.');
  });

  it('resets the turn when the plan is removed', async () => {
    await api.removeAreaPlan(area(180));
    expect(calls.update).toEqual([{ plan_path: null, plan_aspect: null, plan_rotation: 0 }]);
  });

  it('keeps the turn when the plan is replaced', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"/>';
    await api.uploadAreaPlan(area(90), new File([svg], 'revision-2.svg', { type: 'image/svg+xml' }));
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toMatchObject({ plan_aspect: 2 });
    expect(calls.update[0]).not.toHaveProperty('plan_rotation');
  });
});
