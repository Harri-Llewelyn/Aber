import { describe, it, expect, vi } from 'vitest';
import { api } from '../api';

// Mock Supabase client responses so api methods complete without database errors
vi.mock('../lib/supabaseClient', () => {
  const mockQueryBuilder = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    // The telemetry queries end in .order(...).range(...), so order() has to keep
    // returning the builder as well as being awaitable on its own.
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockResolvedValue({ data: [], error: null }),
    then: vi.fn((resolve) => resolve({ data: [], error: null }))
  };

  return {
    SUPABASE_URL: 'http://stack.test',
    SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
    supabase: {
      from: vi.fn(() => mockQueryBuilder),
      // '/api/v1/audit-trail' is served by the audit_trail_page RPC. This path only has to
      // not throw here; what it sends is asserted in apiRelationships.test.js.
      rpc: vi.fn().mockResolvedValue({
        data: { events: [], purged_assets: 0, truncated: false }, error: null
      }),
      // '/api/v1/devices/aas-export' routes through an Edge Function rather than PostgREST,
      // so the mock needs this surface too.
      functions: {
        invoke: vi.fn().mockResolvedValue({ data: {}, error: null })
      },
      // '/api/v1/devices/asset-export' fetches the Edge Function directly (a ZIP must not pass
      // through invoke's text decoding), with the session's token when there is one.
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null } })
      }
    }
  };
});

// The direct fetch above, answered with an empty bundle.
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true, status: 200,
  headers: { get: () => null },
  blob: async () => new Blob([]),
  json: async () => ({})
}));

describe('API Path Coverage Test', () => {
  const getPaths = [
    '/api/v1/archives',
    '/api/v1/archives/retired',
    '/api/v1/archives/exports',
    '/api/v1/cells',
    '/api/v1/gateways',
    '/api/v1/devices',
    '/api/v1/assets',
    '/api/v1/quarantine',
    '/api/v1/audit-trail',
    '/api/v1/cells/some-id/audit-trail',
    '/api/v1/links?entity_type=cell&entity_id=123',
    '/api/v1/devices/dev-123/config',
    '/api/v1/schemas',
    // Reference vocabularies. All three are read-only tables with no write policy, so a route
    // that silently 404s here would leave a vocabulary panel permanently empty rather than error.
    '/api/v1/metric-catalog',
    '/api/v1/metric-groups',
    '/api/v1/mtconnect-vocabulary',
    '/api/v1/iso22400-vocabulary',
    '/api/v1/opcua-vocabulary',
    '/api/v1/idta-submodel-templates',
    '/api/v1/directory',
    '/api/v1/stats',
    '/api/v1/telemetry?limit=500',
    '/api/v1/telemetry/latest?minutes=60'
  ];

  const postPaths = [
    '/api/v1/cells',
    '/api/v1/gateways',
    '/api/v1/devices',
    '/api/v1/cells/cell-123/archive',
    '/api/v1/cells/cell-123/restore',
    '/api/v1/areas/area-123/archive',
    '/api/v1/areas/area-123/restore',
    '/api/v1/quarantine/dev-123/reject',
    '/api/v1/devices/aas-export',
    '/api/v1/devices/asset-export',
    '/api/v1/links',
    '/api/v1/schemas/validate',
    '/api/v1/schemas'
  ];

  const putPaths = [
    '/api/v1/cells/cell-123',
    '/api/v1/gateways/gw-123',
    '/api/v1/devices/dev-123',
    '/api/v1/cells/cell-123/archive',
    '/api/v1/cells/cell-123/restore',
    '/api/v1/links/doc-123'
  ];

  const deletePaths = [
    '/api/v1/areas/area-123',
    '/api/v1/cells/cell-123',
    '/api/v1/gateways/gw-123',
    '/api/v1/devices/dev-123',
    '/api/v1/links/doc-123'
  ];

  it('should handle all GET path strings used across components without throwing Unhandled API path', async () => {
    for (const path of getPaths) {
      await expect(api.get(path)).resolves.not.toThrow();
    }
  });

  it('should handle all POST path strings used across components without throwing Unhandled API path', async () => {
    for (const path of postPaths) {
      await expect(api.post(path, {})).resolves.not.toThrow();
    }
  });

  it('should handle all PUT path strings used across components without throwing Unhandled API path', async () => {
    for (const path of putPaths) {
      await expect(api.put(path, {})).resolves.not.toThrow();
    }
  });

  it('should handle all DELETE path strings used across components without throwing Unhandled API path', async () => {
    for (const path of deletePaths) {
      await expect(api.delete(path)).resolves.not.toThrow();
    }
  });
});
