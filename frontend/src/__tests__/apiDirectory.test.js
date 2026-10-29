import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * GET /api/v1/directory carries each row's known-CVE columns to the page unchanged, and a row the
 * release did not scan arrives with all of them null rather than defaulted to zero.
 */

const rows = vi.hoisted(() => ({ data: [] }));

vi.mock('../lib/supabaseClient', () => {
  const builder = {
    select: vi.fn(() => builder),
    order: vi.fn(() => Promise.resolve({ data: rows.data, error: null }))
  };
  return {
    SUPABASE_URL: 'http://stack.test',
    SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
    supabase: { from: vi.fn(() => builder), auth: { getSession: vi.fn() } }
  };
});

import { api } from '../api';

const ROW = {
  id: 'svc-1',
  service_name: 'Grafana Dashboards',
  service_type: 'MONITORING',
  endpoint_url: 'http://localhost:3002',
  exposure: 'NETWORK',
  image: 'grafana/grafana:13.2.0',
  status: 'ACTIVE',
  last_heartbeat: null
};

beforeEach(() => { rows.data = []; });

describe('/api/v1/directory through the API layer', () => {
  it('passes the scan of the exact image through', async () => {
    rows.data = [{
      ...ROW,
      image_fixable_critical: 0,
      image_fixable_high: 3,
      image_scanned_at: '2026-10-02T07:12:40.118+00:00',
      image_vulnerability_db_at: '2026-10-01T18:41:02+00:00',
      upstream_version: null
    }];
    const [row] = await api.get('/api/v1/directory');
    expect(row).toMatchObject({
      service_uuid: 'svc-1',
      image_fixable_critical: 0,
      image_fixable_high: 3,
      image_scanned_at: '2026-10-02T07:12:40.118+00:00',
      image_vulnerability_db_at: '2026-10-01T18:41:02+00:00'
    });
  });

  it('passes the upstream version of an image Aber builds through', async () => {
    rows.data = [{ ...ROW, image: 'ghcr.io/harri-llewelyn/aber/node-red:1.4.0', upstream_version: '5.0.7' }];
    const [row] = await api.get('/api/v1/directory');
    expect(row.upstream_version).toBe('5.0.7');
  });

  it('leaves an unscanned row null, never zero', async () => {
    rows.data = [ROW];
    const [row] = await api.get('/api/v1/directory');
    expect(row.image_fixable_critical).toBeNull();
    expect(row.image_fixable_high).toBeNull();
    expect(row.image_scanned_at).toBeNull();
    expect(row.upstream_version).toBeNull();
  });
});
