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
    supabase: {
      from: vi.fn(() => mockQueryBuilder),
      // '/api/v1/digital-thread' is served by the digital_thread_page RPC since archived migration 0039 --
      // the deleted-asset filter is an anti-join PostgREST cannot express. This path only has to
      // not throw here; what it sends is asserted in apiRelationships.test.js.
      rpc: vi.fn().mockResolvedValue({
        data: { events: [], purged_assets: 0, truncated: false }, error: null
      }),
      // '/api/v1/devices/aas-export' routes through an Edge Function rather than PostgREST,
      // so the mock needs this surface too.
      functions: {
        invoke: vi.fn().mockResolvedValue({ data: {}, error: null })
      }
    }
  };
});

describe('API Path Coverage Test', () => {
  const getPaths = [
    '/api/v1/archives',
    '/api/v1/cells',
    '/api/v1/gateways',
    '/api/v1/devices',
    '/api/v1/assets',
    '/api/v1/quarantine',
    '/api/v1/digital-thread',
    '/api/v1/cells/some-id/digital-thread',
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
    '/api/v1/quarantine/dev-123/reject',
    '/api/v1/devices/aas-export',
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
